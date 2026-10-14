---
impacto: exige_acao
secao: corrigido
titulo: Worker resolve marcadores de servidor fora do Next.js
---
O worker independente carrega o grafo de módulos de servidor sem alterar a proteção de imports do cliente no Next.js. A imagem usa `pnpm run worker:runtime`; instalações com comando de início personalizado, incluindo Railway, precisam usar esse mesmo comando. A resolução exige Node 22.15 ou superior (a imagem usa Node 22). A validação local bloqueia toda conexão e termina antes dos loops; não prova conectividade nem envio em produção.
