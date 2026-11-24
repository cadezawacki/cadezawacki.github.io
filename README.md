Various tools to help with various things

## Hosting

The site is served by GitLab Pages. There is no build step: every push to
`master` runs the `pages` job in `.gitlab-ci.yml`, which copies the repo into
`public/` (top-level dotfiles left out), adds pre-compressed `.gz` / `.br`
copies of text files, and publishes it. Merge requests run the same copy as
`site-check` without deploying.

Links inside the site are relative, so it works at the root of a domain or
under a project sub-path.

Changes are made on GitHub (`cadezawacki/cadezawacki.github.io`).
`.github/workflows/mirror-to-gitlab.yml` pushes every branch and tag to the
GitLab project (`cadezawacki/cadezawacki-github-io`) and deletes them there
when they're deleted here. It needs the `GITLAB_TOKEN` Actions secret: a GitLab
personal access token with the `write_repository` scope. Don't commit on GitLab
directly; the mirror is one-way.

- Site URL and domains: **Deploy → Pages**
- Who can see the site: **Settings → General → Visibility, project features,
  permissions → Pages** (choose **Everyone** for a public site)
- The Wire's manual sender: **Build → Pipelines → Run pipeline**, then start
  the `fit-push` job. It needs the `VAPID_PRIVATE_KEY` variable under
  **Settings → CI/CD → Variables**; without it the job only does a dry run.
