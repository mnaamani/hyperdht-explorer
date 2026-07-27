Install peer-to-peer (the Pear way).** No clone, no repo — just the published
`pear://` link:

```sh
npx pear-install pear://<key>          # fetch + install the app over the DHT
```

After the first install, new releases reach you over the swarm — no reinstall.
(`pear install` as a built-in CLI subcommand is still "upcoming"; today the
standalone [`pear-install`](https://www.npmjs.com/package/pear-install) module is
the way. It takes a `pear://` link — **not** a local path like `.`.)

### Publishing a release (maintainers)

Distribution rides on a real `upgrade` `pear://` link (the `package.json` field is a
`pear://<YOUR_KEY_HERE>` placeholder until you mint one). Using the
[`pear`](https://docs.pears.com) CLI:

```sh
npm i -g pear                          # the pear CLI
pear touch                             # mint your pear:// link
# paste it into package.json "upgrade"
pear stage <channel>                   # snapshot cwd into the app hypercore
pear seed <channel>                    # seed it so peers (and pear-install) can fetch
```

End users then install with `npx pear-install pear://<key>` (path (a) above). This
mirrors the [hello-pear-bare](https://docs.pears.com/getting-started/from-a-template/start-from-hello-pear-bare)
template we're modeled on.

### OTA self-updates

The pear-runtime updater is wired in but **off by default** — pass `--updates` to
enable it. It spawns a background worker that applies P2P over-the-air updates from
the `upgrade` `pear://` link in `package.json` (set per "Publishing a release"
above). Until a real link is set, leave updates off.
