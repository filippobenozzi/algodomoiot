# AlgoDomo IoT App

Applicazione Node.js leggera con:

- pagina configurazione: `/config`
- pagina controllo: `/control`
- API `GET` con token in query per eseguire i comandi

Protocollo usato: Algo_Domo v1.6 (frame `0x49 ... 0x46`, 14 byte).

## Avvio

```bash
npm start
```

Server default: `http://localhost:8080`

## Configurazione

In `/config` puoi impostare:

- gateway TCP AlgoDomo (`host`, `port`, `timeoutMs`)
- token API GET (`apiToken`)
- schede e ingressi (`boards[].inputs[]`)
- entita da controllare (`entities.lights|shutters|thermostats`)

Note ingressi:

- `g2,g3,g4,targetAddress` sono i byte del comando `0x55` (configurazione ingressi)
- i valori possono essere in decimale o stringa esadecimale (`"0x55"`)

## API GET (autenticate)

Tutte richiedono `?token=...`.

- stato globale:
  - `GET /api/status?token=...&refresh=1`
- luce:
  - `GET /api/cmd/light?token=...&id=light-1&action=on`
  - `action`: `on|off|toggle|pulse|toggle_no_ack`
- tapparella:
  - `GET /api/cmd/shutter?token=...&id=shutter-1&action=up`
  - `action`: `up|down|stop`
- termostato:
  - `GET /api/cmd/thermostat?token=...&id=thermo-1&set=21.5`
- polling scheda:
  - `GET /api/cmd/poll?token=...&address=1`
- invio configurazione ingressi a tutte le schede configurate:
  - `GET /api/cmd/apply-inputs?token=...`
- programmazione indirizzo scheda in modalita Prog:
  - `GET /api/cmd/program-address?token=...&address=5`

## Mapping comandi principali

- Polling esteso: `0x40`
- Relè 1..8: `0x51,0x52,0x53,0x54,0x65,0x66,0x67,0x68`
- Config ingressi: `0x55`
- Stato config ingressi: `0x56`
- Tapparelle: `0x5c`
- Set termostato: `0x5a`

## File principali

- `server.js`
- `public/config.html`
- `public/control.html`
- `data/config.json`
- `data/state.json`
