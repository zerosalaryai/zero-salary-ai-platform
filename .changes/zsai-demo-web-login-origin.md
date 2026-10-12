---
impacto: exige_acao
secao: corrigido
titulo: Login da demonstração valida a origem pública configurada
---

No modo `DEMO_WEB_INGRESS_ONLY`, configure explicitamente `NEXT_PUBLIC_APP_URL`
com a origem HTTPS pública da instalação, sem caminho, query ou fragmento.
O login compara o Origin exatamente com essa origem, sem confiar em headers de
proxy; configuração ausente ou inválida continua negando autenticação.
Falhas da requisição de login aparecem no formulário e permitem tentar novamente,
sem expor detalhes internos. O login fora desse modo mantém o comportamento anterior.
