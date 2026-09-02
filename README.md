# DEGIRO Portfolio

Portfolio tracker with the original backend and a frontend whose design language follows [T3 Code](https://github.com/pingdotgg/t3code).

## Run locally

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The SQLite database is stored in `./data`.

## Docker

```yaml
degiro-portfolio-history:
  image: tristanbomans/degiro-portfolio-history:0.5.10
  ports:
    - 8000:8000
  volumes:
    - <database-folder>:/config
```

## Import data

1. In DEGIRO: Reports → Transactions → export Excel → **Upload transactions**
2. In DEGIRO: Reports → Account statement → export Excel → **Upload account statement**
