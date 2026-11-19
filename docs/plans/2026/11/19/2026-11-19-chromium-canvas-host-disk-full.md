# Blank canvas: a full host disk starved Chromium's `/tmp`

**Date:** 2026-11-19
**Status:** DONE — `docker compose up -d --force-recreate chromium` verified;
CDP and the canvas are healthy. Root disk is still 95% full (see Follow-ups).
**Scope:** meta repo only — `docker-compose.yml`,
`docs/important/dev-env/dev-code-on-nuc-test-on-pp.md`,
`docs/important/testing/how-to-test-all.md`, `README.md`.
**Repos:** no extension submodule changed. The canvas is the shared E2E browser,
so every suite was affected, but the fix belongs to the harness.

## Symptom

`make info` showed the confusing pair:

```text
chromium        up 12 seconds  https://0.0.0.0:9325  200
CDP             down  0.0.0.0:9324 → 127.0.0.1:9222
```

Opening `https://0.0.0.0:9325` served the Selkies page, but the desktop stayed
blank — no Chromium window, no tab strip, no address bar.

The canvas answering `200` only proves that the image's nginx is up. It says
nothing about the desktop or the browser.

## Diagnosis

### The desktop was restarting every second

`docker logs vscode-hacker-meta-chromium-1` repeated:

```text
[svc-de] Wayland mode: Waiting for socket at /config/.XDG/wayland-1...
[svc-de] /config/.XDG/wayland-1 found launching de
No desktop processes found to terminate.
```

Inside the container, `selkies` and nginx were alive, but there was no `labwc`
and no Chromium process. The `svc-de` watchdog was relaunching a desktop that
died immediately.

### `/tmp` could not be written

Running the same Wayland startup by hand as the container's `abc` user gave the
real error:

```text
[ERROR] [xwayland/sockets.c:123] Unable to mkdir /tmp/.X11-unix: No space left on device
[ERROR] [../src/xwayland.c:1216] cannot create xwayland server
```

`df -h /` on the host explained it:

```text
Filesystem      Size  Used Avail Use% Mounted on
/dev/nvme0n1p5  183G  176G     0 100% /
```

The container's `/tmp` lives on that overlay root. With zero bytes free,
Xwayland could not create `/tmp/.X11-unix`, so `labwc` exited, Chromium never
launched, and CDP had nothing to connect to — hence the nginx `502`.

### The Selkies web-extraction error was a red herring

Selkies also logged:

```text
ERROR:server:Failed to extract packaged web files:
  [Errno 28] No space left on device: '/tmp/selkies_webjbvdztq3'
WARNING:server:Unable to find web content, skipping web routers handlers
```

That looked like the blank canvas, but nginx serves the page and its assets from
`/usr/share/selkies/web/`; `index.html`, the JS bundle, and the CSS all returned
`200`. The disk error was real, but it did not explain the missing desktop by
itself.

### Recreating matters, restarting does not

After freeing some space, repeated manual `labwc` attempts failed differently:

```text
Failed to bind socket @/tmp/.X11-unix/X0: Address already in use
... X1, X2, ... X6
```

Those were stale X sockets from the failed attempts. `docker compose restart`
keeps the container filesystem and therefore the stale `/tmp`; a
`--force-recreate` starts a clean `/tmp` and clears them.

## Fix

1. Free space without touching anyone's containers:

   ```bash
   docker builder prune -f
   # Total: 8.737GB
   ```

   This took the root from 0 bytes to about 11 GB free.

2. Recreate the browser so `/tmp` starts clean and the desktop can launch:

   ```bash
   docker compose up -d --force-recreate chromium
   ```

3. Verify the browser, not just nginx:

   ```bash
   curl -s http://127.0.0.1:9324/json/version   # 200, Chrome/156.0.8078.47
   curl -sk -o /dev/null -w '%{http_code}\n' https://127.0.0.1:9325/  # 200
   docker exec vscode-hacker-meta-chromium-1 ps -C labwc -C chromium
   ```

   `make info` now reports `CDP up ... 1 page target`, and `/json/list` shows the
   expected `about:blank` page.

## Hardening: keep the container's `/tmp` in the repo

The first attempt mounted an anonymous tmpfs:

```yaml
tmpfs:
  - /tmp:size=512m
```

It worked, but it was the wrong shape: it put writable state outside the repo,
was invisible to `docker compose` users, and consumed RAM for what is really
ephemeral scratch space. The owner asked for repo-local state instead, matching
`./exp/chromium`:

```yaml
volumes:
  - ./exp/chromium:/config
  - ./exp/tmp:/tmp
```

`exp/` is git-ignored and lives on `/home` (`/dev/nvme0n1p6`, 51 GB free), not
on the full root filesystem. `exp/tmp` was created with mode `1777` so the
container user can create sockets and extract assets.

Verified mount source:

```text
/tmp  /dev/nvme0n1p6[/lamnt45/git/vscode-hacker-meta/exp/tmp]  ext4
```

**Lesson:** prefer a named, inspectable, git-ignored directory under `exp/`
over a tmpfs or any host path outside the checkout. The browser profile and its
scratch space should follow the same lifecycle.

## Disk accounting trap

`docker system df` reported about 61 GB (images, containers, volumes, build
cache), but `/var/lib/docker` was actually **158.9 GB**. The missing ~98 GB was
in the overlayfs snapshotter's container rootfs tree:

```bash
docker run --rm -v /var/lib/docker:/d:ro alpine:latest \
  sh -c 'du -sh /d/rootfs /d/volumes /d/containers'
# 141.1G /d/rootfs
#  17.7G /d/volumes
#  44.5M /d/containers
```

At the time there were **68 running containers** from other projects
(`tupa18-*`, `aqua-dev-*`, `vai-llm-proxy-*`), and 69 rootfs directories. That
is the real consumer, not this repo's two services.

**Lesson:** when `df` and `docker system df` disagree, measure the Docker root
directly with a read-only container. Do not prune other projects' running
containers to make space for the harness.

## Lessons

1. **Canvas `200` is not browser health.** Probe CDP `/json/version` and check
   for a Chromium process; a blank desktop with CDP `502` points at the desktop
   session, not the extension under test.
2. **Check `df -h /` before debugging Wayland.** `/tmp` is part of the container
   overlay, so a full host root breaks Xwayland before any VS Code or extension
   code runs.
3. **The Selkies extraction warning is not necessarily the blank canvas.** nginx
   serves the app from the image; the missing desktop is a separate consequence
   of the same disk pressure.
4. **Recreate, don't restart, after stale X sockets.** `restart` preserves
   `/tmp`; `--force-recreate` gives the desktop a clean socket directory.
5. **Keep harness state under `exp/`.** Use `./exp/tmp` for `/tmp` and
   `./exp/chromium` for the profile; keep it git-ignored, inspectable, and on the
   larger filesystem.
6. **`docker builder prune` is the safe first cleanup.** It reclaimed 8.7 GB
   without stopping any container; leave other projects' running containers
   alone.

## Follow-ups

- **Root is still ~95% full.** Freeing 8.7 GB unblocked the browser, but the
  other 68 running containers still dominate `/var/lib/docker/rootfs`. Stop or
  remove the containers that are no longer needed; this is a host-capacity
  decision, not something the harness should do automatically.
- `make info` still reports **REST control down** and every extension
  **missing**; those are separate from the canvas incident and were not changed
  here.
- The canvas is still 16:9 desktop, not a 16:9 page viewport; see the
  [2026-11-04 headed Chromium plan](../04/2026-11-04-headed-chromium-and-make-info.md).

## Files

| File | What |
| --- | --- |
| `docker-compose.yml` | Chromium `/tmp` moved from the host root to `./exp/tmp` |
| `docs/important/dev-env/dev-code-on-nuc-test-on-pp.md` | Blank-canvas / full-disk troubleshooting note and plan link |
| `docs/important/testing/how-to-test-all.md` | Local-browser blank-canvas / CDP `502` bullet |
| `README.md` | Dated-plan pointer |
| `docs/plans/2026/11/19/2026-11-19-chromium-canvas-host-disk-full.md` | This log |

## Quick reference

```bash
df -h /                                      # is the host root full?
docker logs --tail 50 vscode-hacker-meta-chromium-1
docker exec vscode-hacker-meta-chromium-1 ps -C labwc -C chromium
curl -s http://127.0.0.1:9324/json/version  # CDP, not just nginx
docker builder prune -f                     # safe space reclaim
docker compose up -d --force-recreate chromium
```
