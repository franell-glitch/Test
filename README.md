# Zeiterfassung mit Gesichtserkennung

Webanwendung zur Arbeitszeiterfassung: Mitarbeiter stempeln sich an einem Terminal per Gesichtserkennung ein und aus, die Verwaltung pflegt Mitarbeiter und Gesichter und wertet die Zeiten aus.

## Bereiche

| Bereich | URL | Zweck |
|---|---|---|
| Stempel-Terminal | `/kiosk` | Mitarbeiter schauen in die Kamera → werden erkannt → **Kommen** / **Gehen**. Die passende Aktion ist vorausgewählt und wird nach 5 Sekunden automatisch gebucht. |
| Verwaltung | `/admin` | Mitarbeiter anlegen, bearbeiten, deaktivieren, löschen; Gesichter per Webcam oder Foto erfassen. |
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

## Erste Schritte

1. `/admin` öffnen und mit dem Admin-Passwort anmelden.
2. Mitarbeiter anlegen – der Dialog zur Gesichtserfassung öffnet sich automatisch.
3. 3–5 Aufnahmen speichern (leicht unterschiedliche Kopfhaltung/Licht). Alternativ Fotos hochladen.
4. `/kiosk` auf dem Terminal-Gerät öffnen (am besten im Vollbild-/Kiosk-Modus des Browsers).

## Technik

- **Backend:** Node.js, Express, SQLite (`node:sqlite`)
- **Gesichtserkennung:** [face-api.js](https://github.com/vladmandic/face-api) läuft vollständig im Browser. Aus jedem Gesicht wird ein 128-stelliger Merkmalsvektor berechnet; der Server vergleicht ihn mit den gespeicherten Vektoren (euklidischer Abstand). Die Modelle werden lokal ausgeliefert – keine Cloud, keine externen Dienste.
- Gespeichert werden pro Aufnahme der Merkmalsvektor und ein kleines Vorschaubild.
- Tests: `npm test`

## Wichtige Hinweise

- **Datenschutz (DSGVO):** Gesichtsmerkmale sind biometrische Daten (Art. 9 DSGVO). Für den Einsatz braucht es in der Regel eine Rechtsgrundlage (z. B. freiwillige, schriftliche Einwilligung der Mitarbeiter mit Alternative wie PIN/Karte), ggf. eine Datenschutz-Folgenabschätzung und – falls vorhanden – die Beteiligung des Betriebsrats. Bitte vor dem Produktiveinsatz rechtlich prüfen lassen.
- **Kein Fälschungsschutz:** Es gibt keine Lebenderkennung; ein vorgehaltenes Foto kann unter Umständen erkannt werden. Für ein Terminal unter Aufsicht meist ausreichend, für höhere Anforderungen nicht.
- Vergessene Ausstempelungen werden in der Auswertung markiert und können dort korrigiert werden. Manuelle Änderungen sind als „manuell“ gekennzeichnet.
