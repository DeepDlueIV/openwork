#!/bin/bash
set -euo pipefail
# Share only conversation uploads and outputs. A GUI application must not gain
# access to the command user's home just because both can edit deliverables.
getent group openwork-workspace >/dev/null || groupadd openwork-workspace
usermod -a -G openwork-workspace ubuntu
usermod -a -G openwork-workspace openwork-browser
usermod -a -G openwork-workspace,ubuntu openwork-command
if id -nG openwork-browser | tr ' ' '\n' | grep -qx ubuntu; then
  gpasswd -d openwork-browser ubuntu
fi
chmod 0700 /home/ubuntu /home/openwork-browser
chmod 0700 /home/openwork-command
# Provider file operations use ubuntu; model commands use a separate account
# that cannot invoke the privileged bridge or inspect the GUI user's home.
chown ubuntu:ubuntu /workspace /workspace/.jobs
chmod 2775 /workspace
chmod 2770 /workspace/.jobs
install -d -o ubuntu -g openwork-workspace -m 2770 /workspace/files /workspace/out
# Default ACLs keep new shared files editable across both accounts even though
# command shells and application profiles use a private umask everywhere else.
setfacl -m d:u::rwx,d:g::rwx,d:o::--- /workspace/files /workspace/out
