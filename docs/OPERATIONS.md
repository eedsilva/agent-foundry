# Operação e evolução

## Modos de execução

### Mock

```env
EXECUTOR_MODE=mock
```

O registry devolve um executor determinístico para todos os providers. É o modo correto para desenvolvimento do motor, CI e testes de integração.

### Real

```env
EXECUTOR_MODE=real
RUN_WORKER_INLINE=false
```

O worker precisa encontrar `codex`, `claude` e `agy` no `PATH`, além de sessões autenticadas. O adapter do AGY requer versão 1.1.1 ou superior. Use `npm run doctor` antes de iniciar.

## Topologias

### Local simples

```bash
npm run dev:inline
```

API e worker compartilham processo. Bom para desenvolvimento, ruim para isolamento e escalabilidade.

### Local separado

```bash
npm run dev
```

API, worker e web em processos separados. Um crash de agente não derruba necessariamente a interface.

### Docker mock

```bash
docker compose up --build
```

Usa volume para dados e não injeta credenciais de CLI.

## Recovery manual da fila

Por padrão, um job de projeto tem uma única tentativa de orquestração. Fallbacks de modelo e loops de reparo já acontecem dentro dessa tentativa; repetir o workflow inteiro automaticamente pode duplicar custo e revisões. O endpoint de retry torna uma nova execução uma decisão explícita.

A fila possui:

```text
queue/pending
queue/processing
queue/completed
queue/failed
```

Um crash entre `claim` e `ack/nack` pode deixar job em `processing`. O MVP não possui lease expiry. Para recuperar manualmente com todos os workers parados:

1. inspecione o arquivo em `processing`;
2. remova o sufixo do worker do nome;
3. mova-o de volta para `pending`;
4. reinicie o worker.

Faça isso apenas depois de confirmar que nenhum worker ainda executa o job. Caso contrário, haverá execução duplicada.

## Idempotência

A retomada completa ainda não é idempotente. Reexecutar um projeto pode criar novas revisões e commits. O Git reduz corrupção, mas não garante exactly-once.

Uma evolução robusta deve incluir:

- lease com expiração;
- fencing token;
- chave idempotente por step e iteração;
- status persistido de cada node;
- resume a partir do último checkpoint aprovado;
- side effects externos com deduplicação.

## Observabilidade

Hoje existem três trilhas:

- `events.jsonl` para linha do tempo;
- artefatos `run.*` para auditoria detalhada;
- `metrics/models.json` para roteamento.

Para produção, exporte eventos estruturados para um backend de logs e métricas, mas aplique redaction antes de enviar prompts e stdout.

Métricas úteis:

- tempo de fila;
- duração por node;
- taxa de fallback;
- taxa de aprovação por primeira tentativa;
- número de reparos;
- custo ou quota por projeto;
- falhas por executor e versão;
- defeitos descobertos após aprovação;
- intervenção humana por entrega.

## Atualização de CLIs

CLIs mudam flags e formatos. Faça upgrade deliberado:

1. fixe a versão em ambientes reproduzíveis;
2. rode health check;
3. execute testes de contrato do adapter;
4. rode um conjunto de projetos canário;
5. compare usage, artefatos e permissões;
6. só depois promova.

O comando `--version` prova presença e permite impor mínimos conhecidos, mas não compatibilidade completa. Rode um canário real após qualquer upgrade.

## Catálogo de modelos

Versione qualquer mudança em `models/catalog.yaml`. Registre:

- motivo;
- amostra usada;
- data;
- aliases reais da CLI;
- impacto esperado;
- plano de rollback.

Evite editar priors para “forçar” a escolha desejada sem dados. Nesse caso, use `allowedProviders`, tags ou uma política explícita no workflow. Manipular o score às escondidas só torna a decisão menos legível.

## Harness

Cada alteração no harness deve incrementar `version` em `harness/manifest.json`. Sem isso, duas execuções podem parecer equivalentes apesar de receber instruções diferentes.

Teste mudanças de harness em projetos fixos e compare:

- aprovação;
- retrabalho;
- tamanho do prompt;
- decisões produzidas;
- regressões de segurança.

## Migração para Postgres

Uma sequência razoável:

1. implementar `ProjectRepository`, `ArtifactStore`, `EventStore`, `JobQueue` e `MetricsRepository` em Postgres;
2. preservar os contratos do domínio;
3. usar transação para criar projeto + artefato PRD + job;
4. usar `FOR UPDATE SKIP LOCKED` ou broker com leases;
5. armazenar blobs grandes em object storage;
6. manter metadados e hashes no banco;
7. migrar por projeto e validar hashes.

Não coloque toda a lógica do orquestrador em stored procedure. O banco deve garantir consistência, não virar o novo monólito mágico.

## Escala

O primeiro gargalo provavelmente será tempo de execução e quota das CLIs, não throughput HTTP. Escale workers por classe de workload e provider, respeitando limites de assinatura.

Antes de paralelizar nodes, modele dependências explícitas. Paralelismo sem DAG correto produz conflitos de arquivos e artefatos incoerentes.

## Cancelamento

O MVP não cancela processos ativos. A implementação correta precisa:

- estado `cancel_requested`;
- AbortSignal até o executor;
- encerramento da árvore de processos;
- timeout de graça e kill forçado;
- rollback para checkpoint;
- evento e artefato de cancelamento;
- limpeza segura do job.

## Backup

Em uso local, faça snapshot de `DATA_DIR`. Para restore, preserve permissões e `.git` dos workspaces. O arquivo `artifacts/index.json` pode ser reconstruído a partir das revisões, mas o MVP não inclui ferramenta automática para isso.
