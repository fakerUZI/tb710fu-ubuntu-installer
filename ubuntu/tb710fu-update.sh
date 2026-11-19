#!/bin/bash
# Update installed Ubuntu packages on a running TB710FU.
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
export LC_ALL=C
unset APT_CONFIG

fail() { printf '%s\n' "$*" >&2; exit 1; }

case "${1:---check}" in
    --check) apply=false ;;
    --apply) apply=true ;;
    --help|-h)
        printf '%s\n' '用法：bash tb710fu-update.sh --check' '      sudo bash tb710fu-update.sh --apply'
        exit 0 ;;
    *) fail '请使用 --check 或 --apply。' ;;
esac
[[ $# -le 1 ]] || fail '参数过多。'
[[ $(uname -m) == aarch64 ]] || fail '需要在 TB710FU 的 ARM64 Ubuntu 上运行。'
if [[ ! -r /sys/firmware/devicetree/base/model ]] ||
   [[ $(tr -d '\000' </sys/firmware/devicetree/base/model) != *'Lenovo Xiaoxin Pad Pro GT (TB710FU)'* ]]; then
    fail '未识别到 TB710FU 平板。'
fi
[[ $(. /etc/os-release; printf '%s/%s' "$ID" "${VERSION_CODENAME:-}") == ubuntu/resolute ]] ||
    fail '此入口适用于 TB710FU Ubuntu 26.04（resolute）。'
if $apply; then
    [[ $EUID -eq 0 ]] || fail '应用更新请运行 sudo bash tb710fu-update.sh --apply。'
    [[ -t 0 && -t 1 ]] || fail '请在终端运行更新，以便查看并确认更新计划。'
fi

# Keep device-specific packages and boot tools out of this APT transaction.
protected=(linux-\* firmware-\* initramfs-tools\* dracut\* grub\* shim\* flash-kernel systemd-boot\* u-boot\* tb710fu-\* droidloom\* libcamera\*)
umask 077
prefs=$(mktemp /tmp/tb710fu-apt-preferences.XXXXXXXX)
trap 'rm -f -- "$prefs"' EXIT
printf 'Package: %s\nPin: version *\nPin-Priority: -1\n\n' "${protected[*]}" >"$prefs"
if [[ -r /etc/apt/preferences ]]; then
    cat /etc/apt/preferences >>"$prefs"
fi
apt_options=(
    -o "Dir::Etc::preferences=$prefs"
    -o APT::Get::Upgrade-Allow-New=false
    -o APT::Get::AutomaticRemove=false
    -o APT::Get::Assume-Yes=false
    -o APT::Get::Assume-No=false
    -o DPkg::Options::=--force-confold
    --no-remove
)

audit=$(dpkg --audit)
if [[ -n $audit ]]; then
    printf '%s\n' "$audit" >&2
    fail '软件包管理器还有未完成的操作。请先处理上面的 dpkg 状态。'
fi
if $apply; then
    apt-get -o APT::Update::Error-Mode=any update
else
    printf '%s\n' '根据本机现有软件源索引预览更新。应用时会先刷新索引。'
fi

plan=$(apt-get "${apt_options[@]}" --simulate upgrade)
printf '%s\n' "$plan"
while read -r action package _; do
    case "$action" in
        Remv|Purg) fail '更新计划包含删除操作，已停止。' ;;
        Inst)
            for pattern in "${protected[@]}"; do
                if [[ ${package%%:*} == $pattern ]]; then
                    fail "更新计划包含需要专用更新的组件 $package，已停止。"
                fi
            done ;;
    esac
done <<<"$plan"

if ! $apply; then exit 0; fi
printf '%s\n' 'APT 会显示实际更新计划并请你确认。'
apt-get "${apt_options[@]}" upgrade
if [[ -e /run/reboot-required ]]; then
    printf '%s\n' 'Ubuntu 建议重启以完成更新。请先保存工作。'
fi
