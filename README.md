# DEGIRO Portfolio

Portfolio tracker with the original backend and a frontend whose design language follows [T3 Code](https://github.com/pingdotgg/t3code).

Screenshots below use **mock data**.

## Desktop

<p>
  <img src="docs/screenshots/desktop-overview.png" alt="Overview — mock portfolio summary and holdings" width="900">
</p>
<p>
  <img src="docs/screenshots/desktop-graph.png" alt="Graph — portfolio value, invested capital, and open positions" width="900">
</p>
<p>
  <img src="docs/screenshots/desktop-performance.png" alt="Performance — position chart with relevant ranges only" width="900">
</p>
<p>
  <img src="docs/screenshots/desktop-history.png" alt="History — month-end value and gain or loss" width="900">
</p>
<p>
  <img src="docs/screenshots/desktop-brokers.png" alt="Other brokers — manual holdings" width="900">
</p>

## Mobile

<p>
  <img src="docs/screenshots/mobile-overview.png" alt="Mobile overview" width="320">
  <img src="docs/screenshots/mobile-graph.png" alt="Mobile graph" width="320">
  <img src="docs/screenshots/mobile-performance.png" alt="Mobile performance" width="320">
</p>
<p>
  <img src="docs/screenshots/mobile-history.png" alt="Mobile history" width="320">
  <img src="docs/screenshots/mobile-brokers.png" alt="Mobile other brokers" width="320">
</p>

## Mailbox import

Scan DEGIRO **transactiebevestiging** emails over IMAP. New fills are previewed first; you choose what to add. Existing history is not replaced. Duplicates stay visible but cannot be selected.

<p>
  <img src="docs/screenshots/desktop-mailbox-scan.png" alt="Mailbox scan — choose detected fills" width="900">
</p>
<p>
  <img src="docs/screenshots/mobile-mailbox-scan.png" alt="Mobile mailbox scan" width="320">
</p>

## Run locally

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The SQLite database is stored in `./data`.

## Docker

```yaml
degiro-portfolio-history:
  image: tristanbomans/degiro-portfolio-history:0.5.13
  ports:
    - 8000:8000
  volumes:
    - <database-folder>:/config
```

## Import data

1. In DEGIRO: Reports → Transactions → export Excel → **Upload transactions**
2. In DEGIRO: Reports → Account statement → export Excel → **Upload account statement**
3. Optional: connect a mailbox in Settings and **Scan mail** to add confirmation fills without wiping history
