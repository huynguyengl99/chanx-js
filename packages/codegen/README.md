# @chanx-js/codegen

Generate typed channel descriptors for the [`@chanx-js/client`](https://www.npmjs.com/package/@chanx-js/client)
WebSocket client from a [chanx](https://github.com/huynguyengl99/chanx) AsyncAPI 3 schema.

**[Documentation](https://huynguyengl99.github.io/chanx-js/guide/codegen)**

```bash
npx @chanx-js/codegen http://localhost:8000/asyncapi.json -o src/generated
```

- TypeScript output by default, or JavaScript with `.d.ts` via `--emit js`.
- Optional zod validators with `--validation zod`.
- Reuse types you already have with `--reuse-from`, and check they still match the
  schema with `--reuse-strict`.

MIT licensed.
