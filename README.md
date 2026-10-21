# Zeiterfassung mit Gesichtserkennung

Webanwendung zur Arbeitszeiterfassung: Mitarbeiter stempeln sich an einem Terminal per Gesichtserkennung (alternativ per PIN) ein und aus, die Verwaltung pflegt Mitarbeiter und Gesichter und wertet die Zeiten aus.

## Bereiche

| Bereich | URL | Zweck |
|---|---|---|
| Stempel-Terminal | `/kiosk` | Mitarbeiter schauen in die Kamera → werden erkannt → **Kommen** / **Gehen**. Die passende Aktion ist vorausgewählt und wird nach 5 Sekunden automatisch gebucht. Alternativ: **Mit PIN stempeln**. |
| Verwaltung | `/admin` | Mitarbeiter anlegen, bearbeiten, deaktivieren, löschen; Gesichter per Webcam oder Foto erfassen; PIN vergeben. |
| Datensicherung | `/admin` → Tab „Datensicherung“ | Datenbank herunterladen; automatische tägliche Sicherung nach OneDrive einrichten und prüfen. |
| Auswertung | `/admin` → Tab „Auswertung“ | Pro Mitarbeiter und Tag alle Beginn- und Endzeiten mit Dauer, Tages- und Gesamtsummen; Buchungen korrigieren/ergänzen; CSV-Export (Excel-kompatibel). |

Typischer Tagesablauf: morgens **Kommen**, mittags **Gehen** (Pause), nachmittags **Kommen**, abends **Gehen** – daraus entstehen zwei Zeitblöcke pro Tag. Beliebig viele Blöcke pro Tag sind möglich.

## Installation & Start

Voraussetzung: **Node.js 22.13 oder neuer** (die SQLite-Datenbank ist in Node eingebaut, es werden keine nativen Pakete benötigt).

```bash
npm install
ADMIN_PASSWORD='ein-sicheres-passwort' npm start
```

Danach im Browser öffnen: <http://localhost:3000>

Die Daten liegen in `data/zeiterfassung.db` (regelmäßig sichern!).

### Konfiguration (Umgebungsvariablen)

| Variable | Standard | Bedeutung |
|---|---|---|
| `ADMIN_PASSWORD` | `admin` | Passwort für die Verwaltung – **unbedingt ändern** |
| `PORT` | `3000` | HTTP-Port |
| `DB_PATH` | `data/zeiterfassung.db` | Pfad zur Datenbank |
| `FACE_THRESHOLD` | `0.5` | Erkennungsschwelle (kleiner = strenger, weniger Verwechslungen; größer = toleranter) |
| `STAMP_COOLDOWN_SECONDS` | `60` | Sperrzeit gegen versehentliche Doppelbuchung |
| `MAX_OPEN_HOURS` | `16` | Nach dieser Zeit gilt eine offene Buchung als „Ausstempeln fehlt“ und wird in der Auswertung markiert |

### Kamera & HTTPS

Browser geben die Kamera nur auf **`localhost`** oder über **HTTPS** frei. Läuft das Terminal auf einem anderen Gerät (z. B. Tablet am Eingang), muss der Server hinter einem HTTPS-Reverse-Proxy (z. B. Caddy, nginx, Traefik) betrieben werden.

## Installation auf einem Server (z. B. Oracle Cloud „Always Free“)

Auf einem frischen Ubuntu-Server (22.04/24.04, x86 oder ARM) genügt ein Befehl:

```bash
curl -fsSL https://raw.githubusercontent.com/franell-glitch/Test/HEAD/deploy/install.sh | sudo bash
```

Das Skript [`deploy/install.sh`](deploy/install.sh) installiert Node.js 22 und Caddy, richtet die App als Systemdienst ein, holt automatisch ein HTTPS-Zertifikat, öffnet die Firewall (Ports 80/443) und legt ein tägliches Datenbank-Backup an (`/var/backups/zeiterfassung`, 30 Tage). Am Ende zeigt es die Adresse und das Admin-Passwort an.

- **Ohne eigene Domain** wird automatisch eine kostenlose Adresse der Form `zeit.<server-ip>.sslip.io` verwendet.
- **Ganz ohne Terminal (Oracle):** Beim Erstellen der Instanz unter *Show advanced options → Management → Paste cloud-init script* den Inhalt von [`deploy/oracle-startskript.sh`](deploy/oracle-startskript.sh) einfügen (vorher Passwort eintragen). Der Server richtet sich beim ersten Start selbst ein; Protokoll in `/var/log/zeiterfassung-install.log`.
- **Mit eigener Domain:** DNS-A-Eintrag (z. B. `zeit.example.de`) auf die Server-IP setzen und `sudo DOMAIN=zeit.example.de bash` statt `sudo bash` verwenden.
- **Aktualisieren:** denselben Befehl erneut ausführen – Daten, Passwort und Domain bleiben erhalten.
- **Bei Oracle zusätzlich:** In der Konsole unter *Networking → Virtual Cloud Networks → (dein VCN) → Subnet → Security List* Ingress-Regeln für TCP 80 und 443 von `0.0.0.0/0` anlegen.
- Weitere Programme können später auf demselben Server laufen: Jede App bekommt eine eigene Datei in `/etc/caddy/sites/`.

Nützliche Befehle: `sudo systemctl status zeiterfassung`, `sudo journalctl -u zeiterfassung -f`, Passwort ändern in `/etc/zeiterfassung.env` und danach `sudo systemctl restart zeiterfassung`.

## Erste Schritte

1. `/admin` öffnen und mit dem Admin-Passwort anmelden.
2. Mitarbeiter anlegen – der Dialog zur Gesichtserfassung öffnet sich automatisch.
3. 3–5 Aufnahmen speichern (leicht unterschiedliche Kopfhaltung/Licht). Alternativ Fotos hochladen.
4. Optional eine PIN vergeben (Button „PIN“) – für Mitarbeiter ohne Gesichtsdaten oder wenn die Erkennung einmal nicht klappt.
5. `/kiosk` auf dem Terminal-Gerät öffnen (am besten im Vollbild-/Kiosk-Modus des Browsers).

## Datensicherung

Oracle sichert die Daten auf dem Server **nicht** automatisch. Es gibt drei Ebenen:

1. **Auf dem Server:** täglich nach `/var/backups/zeiterfassung` (30 Tage) – schützt vor Bedienfehlern, nicht vor Serververlust.
2. **Download:** Verwaltung → Datensicherung → „Datensicherung herunterladen“ (konsistente Kopie, auch im laufenden Betrieb).
3. **OneDrive (empfohlen):** Verwaltung → Datensicherung. Einmalig `rclone authorize "onedrive"` auf dem eigenen PC ausführen und das Ergebnis einfügen. Danach lädt die App jede Nacht eine Kopie nach `OneDrive/Zeiterfassung-Backups` (90 Tage Aufbewahrung); Erfolg oder Fehler werden in der Verwaltung angezeigt. Der Zugangsschlüssel liegt nur auf dem Server (`/var/lib/zeiterfassung/rclone.conf`, Rechte 600).

**Wiederherstellen:** Dienst stoppen (`sudo systemctl stop zeiterfassung`), die Sicherungsdatei als `/var/lib/zeiterfassung/zeiterfassung.db` ablegen (vorher `zeiterfassung.db-wal` und `-shm` löschen), `sudo chown zeiterfassung: /var/lib/zeiterfassung/zeiterfassung.db`, Dienst starten.

Hinweis: Die Sicherungen enthalten biometrische Daten – den OneDrive-Ordner nicht freigeben.

## Technik

- **Backend:** Node.js, Express, SQLite (`node:sqlite`)
- **Gesichtserkennung:** [face-api.js](https://github.com/vladmandic/face-api) läuft vollständig im Browser. Aus jedem Gesicht wird ein 128-stelliger Merkmalsvektor berechnet; der Server vergleicht ihn mit den gespeicherten Vektoren (euklidischer Abstand). Die Modelle werden lokal ausgeliefert – keine Cloud, keine externen Dienste.
- Gespeichert werden pro Aufnahme der Merkmalsvektor und ein kleines Vorschaubild.
- **PIN:** 4–8 Ziffern, je Mitarbeiter eindeutig, nur als Hash (scrypt mit geheimem Schlüssel der Installation) gespeichert. Nach 5 falschen Eingaben ist die PIN-Eingabe am Gerät für 5 Minuten gesperrt.
- **CSV-Export:** Semikolon-getrennt, UTF-8 mit BOM (öffnet direkt in Excel). Spalten: Personalnummer, Name, Datum, Beginn, Ende, Dauer (h:mm), Dauer (Std.), Erfassung (Gesicht/PIN/manuell), Notiz.
- Tests: `npm test`

## Wichtige Hinweise

- **Datenschutz (DSGVO):** Gesichtsmerkmale sind biometrische Daten (Art. 9 DSGVO). Für den Einsatz braucht es in der Regel eine Rechtsgrundlage (z. B. freiwillige, schriftliche Einwilligung der Mitarbeiter – wer nicht einwilligt, nutzt die PIN), ggf. eine Datenschutz-Folgenabschätzung und – falls vorhanden – die Beteiligung des Betriebsrats. Bitte vor dem Produktiveinsatz rechtlich prüfen lassen.
- **Kein Fälschungsschutz:** Es gibt keine Lebenderkennung; ein vorgehaltenes Foto kann unter Umständen erkannt werden. Für ein Terminal unter Aufsicht meist ausreichend, für höhere Anforderungen nicht.
- Vergessene Ausstempelungen werden in der Auswertung markiert und können dort korrigiert werden. Manuelle Änderungen sind als „manuell“ gekennzeichnet.
