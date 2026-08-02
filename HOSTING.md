# Putting the game online

The game is a **static site**. There is no backend, no database and no server to
keep running — `index.html`, `src/`, and that is the whole thing. Three.js and
the matchmaking client both load from a CDN.

Online 1v1 does **not** go through your computer. Both players connect outwards
to a public MQTT broker and find each other there, which is why this works from
any host and why nothing here needs a port opened, a firewall rule, or a tunnel.

So: upload these files anywhere that serves static files, and online play works.

## The one thing that cannot be automated

Every public host requires an account. That is not a limitation of this game —
there is no way to publish a website to the internet without an account
somewhere. Pick whichever of these you already have or mind least.

## Option 1 — GitHub Pages (free, permanent URL)

Git is already set up in this folder. Create an empty repository on GitHub, then:

```bash
git remote add origin https://github.com/YOURNAME/YOURREPO.git
git push -u origin main
```

Then in the repository: **Settings → Pages → Source: Deploy from a branch →
`main` / `(root)` → Save**. A minute later the game is at
`https://YOURNAME.github.io/YOURREPO/`.

That URL is the thing you send people. Anyone who opens it and presses the
crossed-swords button gets matched with anyone else doing the same.

## Option 2 — Netlify or Vercel (free, drag and drop)

Sign in, then drag this whole folder onto the deploy area. Both give you a URL
immediately. Netlify's is at <https://app.netlify.com/drop>.

## Option 3 — anything else

Any static host works, including S3, Cloudflare Pages, GitLab Pages, or a folder
on a web host you already pay for. There is nothing to configure.

## Running it locally

`node serve.mjs` still works and is the fastest way to play on this machine or
to develop. It is only a file server now — matches do not involve it.

## What crosses the network

A display name you can change, ball positions, and stroke counts. Nothing else,
and nothing is stored anywhere.

The brokers are the public test endpoints the MQTT projects run themselves, and
they are unauthenticated by design — anyone who knew a match's topic could read
it. Topics are named with 128 bits of randomness, so this is not a practical
concern for a golf score, but it is worth knowing rather than finding out.
