# carbonless

**AI review for the thorough human**

## Install

Needs Node 24, git, and the GitHub CLI (`gh`) logged in (`gh auth login`).

```sh
pnpm add -g carbonless-review          # install (or: npm install -g carbonless-review)
pnpm add -g carbonless-review@latest   # upgrade (or: pnpm update -g carbonless-review)
pnpm add -g carbonless-review@rc       # the release candidate channel
```

pnpm installs a version a day after it is published (its `minimumReleaseAge`);
add `--config.minimumReleaseAgeExclude=carbonless-review` to get it at once.

This installs the `crb` command.

Building from source: [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT: [LICENSE](LICENSE). The packages bundled into the web page keep their own
licenses: `dist/THIRD-PARTY-NOTICES.md` in the npm package, written by the
build (`scripts/third-party-notices.mjs`).
