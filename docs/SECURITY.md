# Segurança

## Aviso principal

Este projeto executa ferramentas agentes sobre um workspace e, depois, pode executar scripts criados por elas. Em modo real, isso é execução de código potencialmente não confiável. Não exponha a API para usuários externos sem isolamento, autenticação e políticas de execução.

## Modelo de ameaça

Atacantes ou entradas defeituosas podem tentar:

- injetar instruções no PRD ou em arquivos do repositório;
- convencer um agente a ler credenciais ou arquivos fora do projeto;
- produzir scripts de build/test maliciosos;
- exfiltrar tokens por rede;
- consumir quota ou CPU indefinidamente;
- usar symlinks ou caminhos especiais;
- contaminar artefatos para enganar reviewers posteriores;
- explorar uma vulnerabilidade da CLI ou de dependências;
- criar output enorme para esgotar memória ou disco.

## Controles presentes

- Schemas Zod para API, workflows, catálogo, artefatos e persistência.
- Sanitização de segmentos usados em caminhos.
- Timeout e limite de output das CLIs.
- Sandbox e permission mode fornecidos por cada CLI.
- Workspace separado por projeto.
- Git checkpoint e rollback para mutações.
- `.gitignore` para reduzir commits acidentais de segredos.
- Verificação determinística configurável.
- Docker em modo mock por padrão, sem montar credenciais do host.

Esses controles reduzem risco. Eles não formam uma barreira forte de isolamento.

## O que não está resolvido

### Isolamento de processo

O worker real roda com as permissões do usuário do host. Um comando permitido pela CLI pode alcançar tudo que esse usuário alcança. O sandbox do fornecedor ajuda, mas não substitui uma fronteira operacional independente. A ADR 0023 introduz a port `ExecutionPlane`, a ADR 0024 define o contrato de ciclo de vida `SandboxRunner`, e a ADR 0025 entrega `DockerSandboxRunner` — um backend rootless real (usuário não-root, sem privileged, capabilities zeradas, rootfs read-only, limites de CPU/memória/pids/disco aplicados). Nenhum caminho de execução hoje constrói um `SandboxSpec`; `LocalExecutionPlane` continua sendo o caminho ativo até a política de rede (`v07-network-policy`) e o secret broker (`v07-secret-broker`) permitirem trocar o padrão com segurança.

### Rede

Não há egress policy. Código executado pode tentar acessar a internet ou serviços internos.

### Segredos

Não existe secret broker por job. A CLI autenticada pode ter credenciais persistidas no perfil do usuário. Montar esse perfil em contêineres de jobs amplia o raio de explosão.

### Multi-tenancy

Não há autenticação, autorização, namespaces por tenant, quota ou auditoria de acesso.

### Código gerado

O verifier pode executar `npm test`, `npm run build` e outros scripts. Um `package.json` hostil pode fazer qualquer coisa que o processo permita.

### Prompt injection

O harness manda tratar conteúdo do projeto como dados, mas um LLM pode desobedecer ou interpretar texto hostil como instrução. Prompt injection não é corrigida apenas com um prompt melhor.

## Recomendação para execução real local

- Use uma conta de sistema dedicada.
- Não coloque chaves de nuvem, SSH ou produção no ambiente do worker.
- Execute apenas PRDs e repositórios em que você confia.
- Mantenha `AUTO_INSTALL_DEPENDENCIES=false` até ter sandbox de rede e processo.
- Revise as políticas de permissão de cada CLI.
- Limite CPU, memória, tempo, processos e espaço em disco.
- Faça backup ou trate `DATA_DIR` como descartável.

## Recomendação para produção

Cada job deve rodar em ambiente efêmero:

1. microVM, VM ou sandbox forte por execução;
2. filesystem novo, sem home do host;
3. credencial de curta duração e escopo mínimo;
4. egress deny-by-default com allowlist;
5. limites de CPU, RAM, pids, tempo e disco;
6. coleta externa de logs;
7. destruição completa ao terminar;
8. artefatos enviados por canal autenticado;
9. verifier fora do host de controle;
10. imagem e dependências fixadas por digest.

Contêiner comum melhora empacotamento, mas não deve ser tratado automaticamente como fronteira suficiente contra código hostil.

## Políticas por executor

### Codex

O adapter usa `read-only` para papéis não mutáveis e `workspace-write` para os demais, com aprovação desabilitada no modo não interativo. Isso exige que o workspace e o processo já estejam isolados adequadamente.

### Claude Code

O adapter usa `plan` para leitura e `acceptEdits` para mutação. Comandos shell adicionais podem depender das políticas locais da CLI. Não foi habilitado bypass global de permissões.

### AGY

O adapter ativa sandbox e usa `plan` ou `accept-edits`. Confirme as políticas e a versão instalada no seu ambiente.

## Dados sensíveis nos artefatos

Run records podem incluir:

- prompt compilado;
- artefatos de entrada;
- harness selecionado;
- stdout e stderr;
- decisões e erros.

Portanto, `DATA_DIR` pode conter dados sensíveis. Não o publique nem o envie integralmente para observabilidade sem redaction.

## Conversas e attachments

Texto e data blocks de mensagens e o nome opcional de attachments passam pelo redactor antes da persistência em `DATA_DIR/projects/<projectId>/conversation/`. A API, o replay SSE e o export leem os valores já redigidos. A proteção é best-effort: padrões ou nomes de campo desconhecidos podem atravessar o filtro, e redaction não corrige dados escritos anteriormente em outras árvores.

Attachments persistem somente metadata: kind, nome opcional, MIME bare `type/subtype` sem parâmetros, SHA-256, tamanho e access scope do projeto. Não existe upload nem armazenamento de blob neste slice (#43). MIME, hash e tamanho são declarações do cliente; não provam conteúdo seguro.

Referências de attachment, run e artifact são verificadas contra o projeto da rota. Isso impede ligações cross-project acidentais ou forjadas dentro do aggregate, mas não autentica o caller e não implementa autorização multi-tenant. Qualquer cliente com acesso à API local ainda pode escolher um project id conhecido. Mantenha a API em loopback/rede privada até existir autenticação e autorização reais.

Uma idempotency key de operação é project-scoped. Retry com o mesmo input devolve o record original; reuso com input diferente falha com `409`, evitando que uma chave seja reinterpretada silenciosamente.

## Verificação de browser

O relatório de browser da issue #32 é evidência JSON limitada: URLs de sessão e mensagens de erro ou
observação removem o token de preview antes de persistir, e o coletor guarda no máximo 100
observações. O token bruto continua material transitório da URL/cookie do proxy; não deve aparecer em
planos, reports, events, logs ou anexos de PR. O relatório aponta para plano e evidência por revisão
imutável (`name`, `revision`, `sha256`), não copia o token nem captura screenshot/trace. Evidência
binária cabe à issue #33.

O bloqueio de tráfego do verificador não é sandbox de rede: ele permite apenas o prefixo exato da
sessão de preview e origens HTTP(S) explicitamente listadas pela policy, mas processo e egress fortes
continuam escopo da issue #120. Mantenha a API/proxy em loopback e trate `browserAllowedOrigins` como
allowlist de segurança, nunca como configuração de conveniência.

Paths do plano passam pelo mesmo validador no contrato e no executor. Traversal e network paths
literais, codificados ou percent-encoded em múltiplas camadas, além de barras invertidas e controles,
são rejeitados antes de qualquer request; a URL resolvida ainda precisa permanecer no prefixo exato.
A instrumentação de quiescência é código estático do executor, não JavaScript vindo do plano. Ela
acompanha somente timers one-shot de até 1.000 ms; esse limite melhora atribuição de falhas sem
transformar intervals ou polling do app em um bloqueio ilimitado.

## Checklist antes de abrir a rede

- autenticação e autorização por rota;
- TLS;
- rate limit e quota;
- CORS restrito;
- validação de tamanho e tipo de PRD;
- isolamento efêmero por job;
- egress control;
- secret broker;
- fila com leasing e recovery;
- cancelamento;
- retenção e redaction;
- trilha de auditoria imutável;
- atualização e pinning de dependências;
- resposta a incidentes.

Sem esses itens, mantenha o serviço em localhost ou rede privada controlada.

## Decisões de segurança do Personal Builder v1

O control plane permanece em loopback no macOS. Publicar um app no VPS não autoriza publicar a API do Agent Foundry.

V1 usa `.env` local por decisão de simplicidade. Esses arquivos são acessíveis ao usuário do host e, portanto, não são um secret broker. Eles precisam estar fora do Git, dos prompts, dos artifacts, das screenshots e dos logs. Scanners devem bloquear promoção quando um valor conhecido aparece no source ou bundle.

SSH do VPS é uma capability do deployer e não uma ferramenta disponível aos agentes. O agente produz um `ReleasePlan`; código determinístico valida e executa os comandos permitidos.

Cada app publicado usa rede, volumes, credenciais e Compose project próprios. Isso reduz colisão acidental, mas não equivale a isolamento multi-tenant. O VPS continua sendo um host confiável do operador.

Rollback automático é limitado ao app. Database restore exige escolha explícita de backup, confirmação humana e registro de auditoria. Destructive migrations sem backup verificado são bloqueadas.
