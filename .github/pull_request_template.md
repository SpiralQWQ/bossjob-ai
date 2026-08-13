---
name: Pull request
about: Submit changes to the project
title: ''
labels: ''
assignees: ''

---

## What does this PR do?

<!-- A clear and concise description of what you changed and why. -->

## Related issue

<!-- Link any related issues, e.g. #42 -->

## How was it verified?

- [ ] `npm run build` passes in `code/frontend` (tsc + vite + verify-csp)
- [ ] `node scripts/verify-endpoint-whitelist.cjs` passes in `code/electron`
- [ ] Backend Python syntax compiles (`python -m compileall app`)
- [ ] Manual smoke test performed (describe)

## Type of change

- [ ] 🐛 Bug fix
- [ ] ✨ New feature
- [ ] 📝 Documentation
- [ ] ♻️ Refactor
- [ ] 🔒 Security / hardening
- [ ] ⚡ Performance

## Checklist

- [ ] No hardcoded secrets or absolute paths introduced
- [ ] No unrelated changes bundled in
- [ ] CHANGELOG updated (if user-facing)
- [ ] Version-sync files updated together if version changed (constants.py + 2× package.json)

## Screenshots (if UI change)

<!-- Add screenshots to help explain your change. -->
