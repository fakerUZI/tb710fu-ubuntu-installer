# TB710FU Ubuntu 单系统安装器 0.3.0-preview

针对 Lenovo TB710FU 的 Ubuntu 单系统实验性安装器。本版本的 Windows 端到端安装及现有 Ubuntu 保留数据覆盖尚未实机验证；使用者需要备份并准备恢复方案。

有两种安装模式：安卓首次安装或清空重装会删除目标 userdata/arch 分区的全部内容；现有 Ubuntu 覆盖模式支持受限制的 arch ext4 布局，尝试保留账户、/home 下的个人文件和用户设置，系统文件及部分系统设置可能被替换。它不支持保留安卓、调整安卓分区大小、独立 /home 或不兼容账户。保留模式在检查文件系统之前先写入临时 boot_a，如果检查失败可能需要恢复启动镜像；请先备份。

## 0.3.0 屏幕键盘补丁

修复解锁或离开密码框后中文候选消失的问题，符号键盘保留四排，Tab、Shift、Ctrl、Alt 和方向键与中英文主键盘对齐。原 Esc 位置的「中符」「英符」用于切换两套标点。点右侧「⇧ []{}|」可打开第二页，直接输入括号、竖线和 ≤、≥、≠。符号页底排的语言键已替换为第一页的「=」和第二页的「±」。原版 0.3.0 和已安装早期版本补丁的用户可直接在 Ubuntu 内更新，保留账户和个人文件。

- [下载屏幕键盘补丁](https://github.com/fakerUZI/tb710fu-ubuntu-installer/releases/download/v0.3.0/TB710FU-v0.3.0-OSK-Hotfix-r5.zip)
- [补丁安装说明](desktop/osk-hotfix/README.md)

## 从官方 0.1／0.2 迁移到 0.3

已安装 0.1.0 或 0.2.0 的单系统用户可使用保留数据的迁移包。先在旧 Ubuntu 内检查启动镜像、固件、分区和账户兼容性，并保存启动镜像备份。随后在 Windows 运行专用迁移入口，使用发布的 0.3.0 系统镜像并保留账户及 `/home` 数据。

- [下载 0.1／0.2 → 0.3 迁移预览包](https://github.com/fakerUZI/tb710fu-ubuntu-installer/releases/download/v0.3.0/TB710FU-Ubuntu-v0.3.0-Migration.zip)
- [迁移说明](migration/README.md)

## Ubuntu 26.04 日常软件包更新

在 TB710FU 的 Ubuntu 26.04 中，可以直接更新已安装的软件包。打开终端，在下载目录运行下面的命令。第一条预览本机索引中的更新，第二条刷新索引并让你在终端确认实际更新计划。

```bash
bash tb710fu-update.sh --check
sudo bash tb710fu-update.sh --apply
```

更新使用本机已配置的 APT 软件源，保留现有账户、家目录和用户设置。APT 保留修改过的配置文件，不卸载已安装的软件包。TB710FU 专用内核、固件及硬件适配请通过平板上的修复助手更新。这个入口适用于 Ubuntu 26.04 内的日常更新。

- [下载 Ubuntu 原地更新脚本](https://github.com/fakerUZI/tb710fu-ubuntu-installer/releases/download/ubuntu-update-v1/tb710fu-update.sh)
- [Ubuntu 软件包管理说明](https://ubuntu.com/server/docs/how-to/software/package-management/)

## Windows 安装

需要已解锁的 Bootloader、fastboot 驱动、Windows 本地磁盘至少 40 GiB 空闲及可靠的数据线。不要重锁 Bootloader。从 Releases 下载启动包，在 Windows 解压并运行 `windows/install.cmd`。按提示选择模式并输入 ERASE 或 KEEP。镜像分片联网下载并校验；安装完成后重启 Ubuntu。不要公开安装工作目录。

系统包含 200% 默认缩放、自定义电源键、皮套背光、输入法和后摄适配。账户名通过活动会话识别。启动镜像使用经核对的 20261118 TB710FU 内核；[内核发布与源码](https://github.com/fakerUZI/tb710fu-repair-catalog/releases/tag/kernel-20261118)。本版本 Windows 安装和覆盖安装尚待实机确认。

`device/` 是设备端安装逻辑，`windows/` 是 Windows 入口，`tools/` 包含 NBD 服务器与构建工具，`desktop/` 包含桌面适配源码。本仓库不提供完整镜像重建环境；部分组件需要上游源码、工具链和输入。

Kimpanel 修改继承 GPL-2.0-or-later，许可见 `desktop/kimpanel/COPYING`。NBD 服务器和部分启动工具源自 [TB710FU Arch Linux port](https://github.com/deinthoedoka/TB710FU-Archlinux)，遵循附带许可。发行文件包含硬件固件，其再分发许可需要核实。设备备份、个人数据、凭据、设备唯一标识和已停止的前摄实验不属于公开内容。

镜像保留修复助手和 Google Chrome，排除原机浏览器用户资料、账户与缓存；QQ、WorkBuddy 和 FlClash 不包含在内。Chrome 和固件的再分发条件需要核实；参见 [Chrome 附加条款](https://www.google.com/chrome/terms/)和 [Google 服务条款](https://policies.google.com/terms)。

本版本镜像中实际安装的屏幕键盘扩展源码见 `desktop/installed-20261119/`；主分支同时保留后续合并的扩展改动。
