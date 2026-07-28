# Releasing and installing

Two ways to get hyperdht-explorer onto a machine: over the DHT (the Pear way), or
by copying the standalone binary. The cron wrappers in `ops/` need **(b)** — they
call the installed `hyperdht-explorer` command directly.

### (a) Install peer-to-peer (the Pear way)

No clone, no repo — just the published `pear://` link:

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

### (b) Install the standalone binary

`bare-build --standalone` emits a real native executable (ELF on Linux, Mach-O on
macOS) with the Bare runtime and native addons bundled in — no `bare` needed on
the target. This is what the `ops/` cron wrappers run, and they run it **by name
from PATH**, so a new subcommand does not exist for cron until the installed copy
is replaced. If a scheduled run starts logging usage text and
`… exited non-zero`, the installed binary is older than the wrapper expects.

Build for the target's platform (cross-compiling is fine — build on macOS for a
Linux server):

```sh
npm run make                # host platform      -> out/<host>/
npm run make:linux-x64      # or linux-arm64, darwin-arm64, win32-x64, …
```

#### Replacing a binary that is in use

Copying over the existing file on Linux fails with **`ETXTBSY`**, which the shell
reports as **"Text file busy"**:

```
cp: cannot create regular file '/usr/local/bin/hyperdht-explorer': Text file busy
```

This is neither a permission problem nor a sign that the file is a script.
"Text" means the _text segment_ — the code segment of an executable. Linux
refuses to open a file for writing while it is being executed, and `cp` opens the
destination `O_WRONLY|O_TRUNC`, i.e. writes into the very inode the running
process is executing from. `sudo` does not help; it is a kernel interlock, not a
mode check. (macOS is more permissive, so this only shows up on the server.)

The fix is to replace the **directory entry** rather than the file. `rename(2)`
leaves the old inode alone: a run already in flight keeps executing it until it
exits, and the next run picks up the new one.

```sh
# stage alongside the target, on the SAME filesystem, then rename over it
scp out/linux-x64/hyperdht-explorer \
    user@host:/usr/local/bin/hyperdht-explorer.new
ssh user@host 'chmod +x /usr/local/bin/hyperdht-explorer.new &&
               mv -f /usr/local/bin/hyperdht-explorer.new \
                     /usr/local/bin/hyperdht-explorer'
```

Two details that matter:

- **Same filesystem.** Stage in the target's own directory. Across a mount
  boundary `mv` cannot rename, so it falls back to copy-then-unlink — and the
  copy hits `ETXTBSY` again.
- **Prefer `mv` over `rm` + `cp`.** Unlinking first also works (the running
  process keeps the inode alive through its open handle), but leaves a window
  where the command does not exist. A cron job firing in that window logs a
  failure. A rename has no such window.

Then confirm the right build actually landed:

```sh
ssh user@host 'hyperdht-explorer help | head -1'
```

#### One wrinkle with long-running collectors

A run already in flight finishes on the **old** code. `traffic` defaults to
`--minutes 60`, and its wrapper re-renders `stats.html` and `timeline.html` when
it ends — so a page can be written by the previous binary up to an hour after you
installed the new one. Harmless, but it explains a report that looks stale right
after a deploy. Each wrapper holds a lock dir at the repo root, so you can check
before installing:

```sh
ls -d ~/hyperdht-explorer/.{scan,traffic,storeprobe,observe,seeders}.lock 2>/dev/null
```

### OTA self-updates

The pear-runtime updater is wired in but **off by default** — pass `--updates` to
enable it. It spawns a background worker that applies P2P over-the-air updates from
the `upgrade` `pear://` link in `package.json` (set per "Publishing a release"
above). Until a real link is set, leave updates off.
