#!/bin/bash
# Experimental source only. Never install until integration and hardware tests pass.
# Single-system installation offers clean and existing-Ubuntu preserve modes.
set -euo pipefail
fail() { echo "INSTALL FAILED: $*" >&2; exit 1; }
[ "${TB710FU_ENABLE_UNTESTED_INSTALLER:-}" = yes ] || fail 'Untested development code is disabled'
[ "$(id -u)" = 0 ] || fail 'root privileges required'
for cmd in findmnt lsblk sgdisk blockdev blkid e2fsck mkfs.ext4 rsync sha256sum dd mount umount python3 partprobe swapon reboot; do
  command -v "$cmd" >/dev/null || fail "missing tool: $cmd"
done
model=$(tr '\0' ' ' </sys/firmware/devicetree/base/model)
[[ "$model" == *TB710FU* ]] || fail 'not a TB710FU'
[[ " $(cat /proc/cmdline) " == *' tb710fu.install=single '* ]] || fail 'not booted in single install mode'
root=$(findmnt -n -o SOURCE /)
[ "$root" = /dev/nbd0p2 ] || fail 'installer root is not the expected NBD partition'
[ -b /dev/nbd0p1 ] || fail 'NBD control partition missing'
[ "$(blockdev --getsize64 /dev/nbd0p1)" = 134217728 ] || fail 'unexpected control partition size'
request=$(dd if=/dev/nbd0p1 bs=512 count=1 status=none | tr -d '\000' | head -n 1)
[[ "$request" =~ ^TB710FU-REQUEST:([0-9a-f]{32}):([0-9a-f]{64}):100663296:(clean|preserve)$ ]] || fail 'invalid host installation request'
nonce=${BASH_REMATCH[1]}
expected=${BASH_REMATCH[2]}
mode=${BASH_REMATCH[3]}
# Current verified kernel/DT is derived from the original Ubuntu baseline.
[ "$expected" = d83ee187bce60b30c2f28c177b3ab158ea96e5688547e06d3dd4d7a7ed1d6e10 ] || fail 'boot image does not match the verified Ubuntu kernel'
boot_image=/run/tb710fu-final-boot.img
[ ! -e "$boot_image" ] || fail 'temporary boot image already exists'
umask 077
dd if=/dev/nbd0p1 of="$boot_image" bs=4096 skip=1 count=24576 status=none || fail 'could not read host boot image'
[ "$(stat -c %s "$boot_image")" = 100663296 ] || fail 'truncated boot image'
[ "$(sha256sum "$boot_image" | awk '{print $1}')" = "$expected" ] || fail 'boot checksum mismatch'
for file in /usr/lib/firmware/qcom/sm8650/xiaoxin/gt/adsp.mbn /usr/lib/firmware/qcom/sm8650/xiaoxin/gt/cdsp.mbn /usr/lib/firmware/ath12k/WCN7850/hw2.0/amss.bin; do
  [ -s "$file" ] || fail 'device firmware missing; refusing before disk changes'
done
[ -x /usr/libexec/gnome-initial-setup ] || fail 'first-run setup missing'
# Resolve a unique GPT label from sysfs, refusing duplicate labels.
partdev() {
  local wanted=$1 p result='' count=0
  for p in /sys/class/block/sd*; do
    [ -f "$p/partition" ] && [ -r "$p/uevent" ] || continue
    if grep -Fxq "PARTNAME=$wanted" "$p/uevent"; then result=/dev/${p##*/}; count=$((count+1)); fi
  done
  [ "$count" -le 1 ] || return 1
  printf '%s\n' "$result"
}
arch=$(partdev arch) || fail 'duplicate arch partitions'
userdata=$(partdev userdata) || fail 'duplicate userdata partitions'
[ -z "$arch" ] || [ -z "$userdata" ] || fail 'existing dual layout requires manual review'
target=${arch:-$userdata}
[ -n "$target" ] && [ -b "$target" ] || fail 'no unique target partition'
parent=$(lsblk -ndo PKNAME "$target")
[[ "$parent" =~ ^sd[a-z]+$ ]] || fail 'unexpected target disk'
disk=/dev/$parent
number=$(cat "/sys/class/block/${target##*/}/partition")
[[ "$number" =~ ^[1-9][0-9]*$ ]] || fail 'unexpected partition number'
[ "$(blockdev --getss "$disk")" = 4096 ] || fail 'unexpected sector size'
[ "$(blockdev --getsize64 "$target")" -ge 34359738368 ] || fail 'target is smaller than 32 GiB'
for entry in /sys/class/block/"$parent"*; do
  [ -f "$entry/partition" ] || continue
  candidate=/dev/${entry##*/}
  if findmnt -rn -S "$candidate" | grep -q .; then fail 'a partition on the target disk is mounted'; fi
  if swapon --noheadings --raw --output NAME | grep -Fxq "$candidate"; then fail 'a partition on the target disk is active swap'; fi
done
boot=$(partdev boot_a) || fail 'duplicate boot_a partitions'
[ -n "$boot" ] && [ -b "$boot" ] || fail 'boot_a is not a block device'
size=$(stat -c %s "$boot_image")
[ "$size" -eq "$(blockdev --getsize64 "$boot")" ] || fail 'boot image size mismatch'
[ $((size % 4194304)) -eq 0 ] || fail 'boot size is not aligned'
sgdisk --verify "$disk" >/dev/null || fail 'GPT verification failed'
mkdir -p -m 700 /root/tb-install-backup
[ ! -e /root/tb-install-backup/gpt-before.bin ] || fail 'backup already exists'
sgdisk --backup=/root/tb-install-backup/gpt-before.bin "$disk" || fail 'GPT backup failed'
[ -s /root/tb-install-backup/gpt-before.bin ] || fail 'empty GPT backup'
mkdir -p /mnt/tb-install-target
account_dir=/run/tb-preserve-accounts
if [ "$mode" = preserve ]; then
  [ -n "$arch" ] && [ -z "$userdata" ] || fail 'preserve mode requires a unique existing arch partition'
  [ "$(blkid -s TYPE -o value "$target")" = ext4 ] || fail 'preserve mode requires ext4'
  e2fsck -fn "$target" >/dev/null || fail 'existing filesystem requires repair; refusing preserve mode'
  mount -o ro,noload "$target" /mnt/tb-install-target || fail 'cannot inspect existing Ubuntu'
  trap 'umount /mnt/tb-install-target 2>/dev/null || true' EXIT
  python3 /usr/local/libexec/tb-validate-preserve-root.py /mnt/tb-install-target || fail 'unsupported existing Ubuntu layout'
  python3 /usr/local/libexec/tb-merge-accounts.py --existing /mnt/tb-install-target/etc --release /etc --out "$account_dir" || fail 'incompatible accounts or groups'
  need_kib=$(df -Pk / | awk 'NR==2 {print $3}')
  free_kib=$(df -Pk /mnt/tb-install-target | awk 'NR==2 {print $4}')
  [[ "$need_kib" =~ ^[0-9]+$ && "$free_kib" =~ ^[0-9]+$ ]] || fail 'cannot determine free space'
  [ "$free_kib" -gt $((need_kib + 1048576)) ] || fail 'not enough free space for preserve mode'
  umount /mnt/tb-install-target || fail 'cannot unmount validation root'
  trap - EXIT
else
  # Clean mode deliberately destroys the selected userdata or arch contents.
  if [ -n "$userdata" ]; then
    sgdisk --change-name="$number:arch" --typecode="$number:8300" "$disk" || fail 'GPT rename failed'
    partprobe "$disk" || fail 'partition table rescan failed'
    [ "$(partdev arch)" = "$target" ] || fail 'renamed partition was not verified'
  fi
  mkfs.ext4 -F -L ubuntu-root "$target" || fail 'filesystem creation failed'
fi
mount -o noatime "$target" /mnt/tb-install-target || fail 'target mount failed'
trap 'umount /mnt/tb-install-target 2>/dev/null || true' EXIT
excludes=(--exclude=/proc --exclude=/sys --exclude=/dev --exclude=/run --exclude=/tmp --exclude=/mnt --exclude=/media --exclude=/var/tmp --exclude=/var/log --exclude=/var/cache --exclude=/etc/machine-id --exclude='/etc/ssh/ssh_host_*' --exclude=/var/lib/systemd/random-seed --exclude=/boot/tbboot)
if [ "$mode" = preserve ]; then
  excludes+=(--exclude=/home --exclude=/root --exclude=/etc/passwd --exclude=/etc/shadow --exclude=/etc/group --exclude=/etc/gshadow --exclude=/etc/subuid --exclude=/etc/subgid --exclude=/etc/fstab --exclude=/etc/hostname --exclude=/etc/hosts --exclude=/etc/sudoers.d --exclude=/etc/gdm3/custom.conf --exclude=/etc/droidloom --exclude=/etc/tb710fu/release-owner-unclaimed --exclude=/etc/NetworkManager/system-connections --exclude=/var/lib/AccountsService --exclude=/var/lib/NetworkManager --exclude=/var/lib/bluetooth --exclude=/var/lib/droidloom --exclude=/var/lib/snapd)
fi
rsync -aHAXxc --numeric-ids "${excludes[@]}" / /mnt/tb-install-target/ || fail 'system copy failed'
if [ "$mode" = preserve ]; then
  # Older supported Ubuntu installs may not yet have a Droidloom owner.
  # Keep an existing configuration; otherwise provision the first active user.
  if [ ! -e /mnt/tb-install-target/etc/droidloom/cell.json ]; then
    [ ! -L /mnt/tb-install-target/etc/droidloom ] && [ ! -L /mnt/tb-install-target/etc/droidloom/cell.json ] || fail 'unsafe Droidloom target'
    install -d -m 755 /mnt/tb-install-target/etc/droidloom /mnt/tb-install-target/etc/tb710fu
    install -m 644 /etc/droidloom/cell.json /mnt/tb-install-target/etc/droidloom/cell.json
    : > /mnt/tb-install-target/etc/tb710fu/release-owner-unclaimed
  fi
  for file in passwd shadow group gshadow; do
    old="/mnt/tb-install-target/etc/$file"
    [ -f "$old" ] && [ ! -L "$old" ] || fail 'account database changed during installation'
    install -m "$(stat -c %a "$old")" -o "$(stat -c %u "$old")" -g "$(stat -c %g "$old")" "$account_dir/$file" "$old.tb-new" || fail 'account staging failed'
    mv -f "$old.tb-new" "$old" || fail 'account installation failed'
  done
fi
mkdir -p /mnt/tb-install-target/{proc,sys,dev,run,tmp,mnt,media,var/tmp,var/log,var/cache}
# The installed system must not retain an enabled installer.
rm -f /mnt/tb-install-target/etc/systemd/system/sysinit.target.wants/tb-installer.service /mnt/tb-install-target/etc/systemd/system/tb-installer.service /mnt/tb-install-target/usr/local/sbin/tb-install-single
chmod 1777 /mnt/tb-install-target/tmp /mnt/tb-install-target/var/tmp
if [ "$mode" = clean ]; then : > /mnt/tb-install-target/etc/machine-id; fi
sync
umount /mnt/tb-install-target
trap - EXIT
# Install the verified baseline-derived Ubuntu boot and read back every byte.
dd if="$boot_image" of="$boot" bs=4M conv=fsync status=none || fail 'boot write failed'
actual=$(dd if="$boot" bs=4M count=$((size/4194304)) status=none | sha256sum | awk '{print $1}')
[ "$actual" = "$expected" ] || fail 'boot read-back mismatch'
sync
# The host recognises only a response for this installation's random nonce.
printf 'TB710FU-OK:%s\n' "$nonce" | dd of=/dev/nbd0p1 bs=512 count=1 conv=sync,fsync status=none || fail 'completion signal failed'
echo 'INSTALL_OK: rebooting into the installed system.'
sync
reboot -f
fail 'reboot command returned unexpectedly'
