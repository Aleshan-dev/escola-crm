<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

<!-- BEGIN:pasta-unica -->
# Pasta única do projeto — FONTE DE VERDADE

Todo o trabalho deste projeto (edição de código E deploy) acontece EXCLUSIVAMENTE nesta pasta:
`D:\Claude\Projects\CRM Escola`

- Não existe mais cópia entre pastas. As pastas antigas (`C:\Users\alesh\Claude\Projects\CRM Escola`, `C:\Users\alesh\escola-crm-code`, `C:\Users\alesh\Documents\escola-crm`) foram DESCONTINUADAS — ignore-as. A confusão de editar numa pasta e deployar de outra já quebrou a aba de alertas uma vez; nunca mais.
- Antes de editar qualquer arquivo, LEIA a versão atual desta pasta. Ela é a fonte de verdade — nunca assuma conteúdo a partir da memória.
- Deploy (o git auto-deploy está quebrado): `cd /d "D:\Claude\Projects\CRM Escola"` e depois `npx vercel@latest --prod`.
- Mudanças de banco (Supabase MCP) já vão ao ar na hora; mudanças de CÓDIGO só depois do deploy acima.
<!-- END:pasta-unica -->
