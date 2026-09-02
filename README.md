# DEGIRO Portfolio

Fork of [RobbeVanHemelryck/degiro-portfolio-history](https://github.com/RobbeVanHemelryck/degiro-portfolio-history).

Portfolio tracker for DEGIRO history: live value, performance per position, and mailbox import of confirmation emails.

Screenshots below use **sample data** (fictional holdings, amounts unrelated to any real portfolio).

## Desktop

![Overview](docs/screenshots/desktop-overview.png)

![Graph](docs/screenshots/desktop-graph.png)

![Performance](docs/screenshots/desktop-performance.png)

![History](docs/screenshots/desktop-history.png)

![Other brokers](docs/screenshots/desktop-brokers.png)

## Mobile

<p><img src="docs/screenshots/mobile-overview.png" alt="Mobile overview" width="360"></p>

<p><img src="docs/screenshots/mobile-graph.png" alt="Mobile graph" width="360"></p>

<p><img src="docs/screenshots/mobile-performance.png" alt="Mobile performance" width="360"></p>

<p><img src="docs/screenshots/mobile-history.png" alt="Mobile history" width="360"></p>

<p><img src="docs/screenshots/mobile-brokers.png" alt="Mobile other brokers" width="360"></p>

## Mailbox import

Scan DEGIRO **transactiebevestiging** emails over IMAP. New fills are previewed first; you choose what to add. Existing history is not replaced. Duplicates stay visible but cannot be selected.

![Mailbox scan](docs/screenshots/desktop-mailbox-scan.png)

<p><img src="docs/screenshots/mobile-mailbox-scan.png" alt="Mobile mailbox scan" width="360"></p>

## Run locally

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The SQLite database is stored in `./data`.

## Docker

Build the image from this repository:

```bash
docker build -t degiro-portfolio .
```

Then run it:

```yaml
degiro-portfolio:
  image: degiro-portfolio
  ports:
    - 8000:8000
  volumes:
    - <database-folder>:/config
```

The app listens on port `8000` inside the container. Persist the SQLite database by mounting a folder at `/config`.

## Import data

1. In DEGIRO: Reports → Transactions → export Excel → **Upload transactions**
2. In DEGIRO: Reports → Account statement → export Excel → **Upload account statement**
3. Optional: connect a mailbox in Settings and **Scan mail** to add confirmation fills without wiping history
