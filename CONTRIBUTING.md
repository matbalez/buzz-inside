# Contributing

Contributions from people and their coding agents are welcome.

## Propose a change

1. Fork the repository and create a focused branch from `main`.
2. Install dependencies with `npm ci`.
3. Make the smallest change that solves the problem.
4. Run the full verification suite:

   ```bash
   npm run lint
   npm test
   npm audit --omit=dev
   ```

5. Open a pull request describing what changed, why it changed, its user
   impact, and the checks you ran.

Bug reports and feature proposals are also welcome through GitHub Issues.

## Agent-assisted contributions

Changes prepared with a coding agent follow the same pull-request process and
quality bar as any other contribution. The submitting GitHub account remains
responsible for reviewing the change, keeping credentials and private data out
of the contribution, and responding to review feedback.

## Project expectations

- Keep changes scoped and follow the conventions in the surrounding code.
- Add or update tests when behavior changes.
- Preserve the local-first security model and avoid introducing analytics,
  application secrets, or unnecessary persistence.
- Be respectful and constructive in issues and reviews.

By contributing, you agree that your contribution is licensed under the
project's [MIT License](LICENSE).
