#!/bin/bash
# Oracle Cloud: Beim Erstellen der Instanz unter "Show advanced options" > "Management"
# > "Paste cloud-init script" komplett einfügen. Der Server richtet sich beim ersten Start selbst ein.
#
# Vorher anpassen: Admin-Passwort (mind. 12 Zeichen, nur Buchstaben und Ziffern).
# Optional: eigene Domain, deren DNS-A-Eintrag auf die Server-IP zeigt – sonst leer lassen.
ADMIN_PASSWORD='HierDeinPasswort'
DOMAIN=''

export ADMIN_PASSWORD DOMAIN
curl -fsSL https://raw.githubusercontent.com/franell-glitch/Test/HEAD/deploy/install.sh -o /root/install.sh
bash /root/install.sh > /var/log/zeiterfassung-install.log 2>&1
