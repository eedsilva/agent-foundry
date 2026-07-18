# Model routing

## Problema real

Escolher “Claude para planejar e Codex para programar” é uma regra inicial aceitável, mas não é uma política adaptativa. Tarefas mudam de tamanho, risco, contexto e urgência. Modelos, quotas e versões também mudam.

O router deste projeto transforma cada etapa em um perfil e ranqueia um catálogo configurável. A decisão completa é anexada ao artefato, portanto pode ser auditada depois.

## Entrada: `TaskProfile`

```ts
interface TaskProfile {
  role: AgentRole;
  taskKind: TaskKind;
  taxonomyVersion: '1' | '2';
  category: TaskCategory;
  features: TaskFeature[];
  complexity: 1 | 2 | 3 | 4 | 5;
  risk: 1 | 2 | 3 | 4 | 5;
  estimatedContextTokens: number;
  estimatedOutputTokens: number;
  mutatesWorkspace: boolean;
  priorities: {
    quality: number;
    speed: number;
    cost: number;
    reliability: number;
  };
  allowedProviders?: Array<'codex' | 'claude' | 'agy'>;
  preferredTags: string[];
}
```

`TaskProfiler` combina defaults por tipo de tarefa com overrides do workflow. A estimativa de tokens é deliberadamente aproximada. Ela serve para rejeitar escolhas obviamente incompatíveis e ponderar custo, não para billing exato.

`TaskKind` continua sendo a chave de compatibilidade v1 e o campo enviado ao plano de execução. A
taxonomia v2 acrescenta estas categorias:

- `planning` e `architecture`;
- `implementation/general`, `implementation/frontend`, `implementation/backend`,
  `implementation/database`, `implementation/integration` e `implementation/tests`;
- `review/plan`, `review/architecture` e `review/code`;
- `repair/general`, `repair/frontend`, `repair/backend`, `repair/database`, `repair/integration` e
  `repair/tests`;
- `verification/tests`.

Os features possíveis são `frontend`, `backend`, `database`, `integration` e `tests`. Uma categoria
declarada no workflow prevalece. Quando ela é omitida, o profiler extrai todos os features encontrados,
em ordem determinística (`database`, `frontend`, `backend`, `integration`, `tests`), das instruções,
harness, artefatos de entrada e tags. Implementação e reparo usam o primeiro feature ou `general`; os
demais `TaskKind` têm mapeamento fixo. Perfis antigos sem os novos campos são normalizados como
taxonomia v1, com a categoria legada correspondente e `features: []`.

## Catálogo

Cada modelo possui:

- provider e nome enviado à CLI;
- billing mode;
- preços opcionais;
- janela de contexto declarada;
- capacidade de escrever no workspace;
- tags;
- priors de capacidade entre 0 e 1.

Exemplo de modelo medido por token:

```yaml
- id: provider-model-x
  provider: codex
  model: model-x
  billingMode: metered
  pricing:
    inputUsdPerMillionTokens: 2.00
    outputUsdPerMillionTokens: 8.00
  enabled: true
  maxContextTokens: 120000
  canWriteWorkspace: true
  tags: [coding, balanced]
  capabilities:
    planning: 0.80
    architecture: 0.82
    coding: 0.93
    review: 0.87
    repair: 0.92
    structuredOutput: 0.91
    speed: 0.72
    costEfficiency: 0.65
    reliability: 0.90
```

Não copie preços antigos da internet e trate como verdade eterna. Mantenha o catálogo sob controle de versão e atualize apenas com dados verificáveis.

## Hard constraints

Antes do score, um candidato é rejeitado quando:

- o provider não está permitido;
- a tarefa altera o workspace e o modelo não pode escrever;
- a janela de contexto declarada é menor que o contexto estimado.

Restrições duras não devem virar penalidades suaves. Um modelo incapaz não fica adequado por ganhar pontos em velocidade.

## Pins explícitos auditados

Pins de retry, step e run usam o mesmo caminho de validação do roteamento automático. A
precedência é `retry > step mais novo > run mais novo`. O record guarda o tuple resolvido do
catálogo, o ator, motivo e impacto estimado; `RouteDecision.override` torna a escolha aplicada
visível no artifact.

Um pin explícito retorna exatamente um candidato e `fallbacks: []`. Ele não transforma restrições
duras em preferências: modelo desabilitado, drift de `modelId/provider/model`, provider proibido
por ProjectPolicy ou pelo step, contexto insuficiente e falta de capacidade de escrita continuam
rejeitando a rota antes da execução.

## Score

O score final normaliza os pesos da tarefa:

```text
total =
  qualityWeight     * qualityComposite +
  speedWeight       * speed +
  costWeight        * costEfficiency +
  reliabilityWeight * reliability
```

### Capacidade

A capacidade depende do tipo de tarefa. Revisão de arquitetura, por exemplo, combina `review` e `architecture`; reparo combina `repair` e `coding`.

### Contexto

Combina headroom da janela com capacidade de structured output. Uma janela quase cheia recebe score menor, mesmo que ainda passe pela restrição dura.

### Velocidade

Começa com o prior do catálogo. Quando há histórico, mistura a duração média observada para aquele modelo, papel e tipo de tarefa.

### Confiabilidade

Combina:

- prior de confiabilidade;
- taxa de sucesso operacional suavizada;
- taxa de aprovação em quality gates;
- penalidade por falhas consecutivas.

Suavização evita declarar um modelo perfeito após uma única execução boa.

### Custo

Há dois casos diferentes:

1. **Assinatura:** normalmente não existe preço marginal confiável por chamada. O prior `costEfficiency` representa pressão sobre quota, latência e custo de oportunidade.
2. **Metered:** se houver pricing ou custo reportado pela CLI, o router estima USD e usa isso com peso maior.

Misturar esses casos em um único “preço” inventado seria precisão teatral.

### Afinidade de tags

Tags permitem preferências específicas, como `architecture`, `fast`, `review` ou `workspace-write`. Elas influenciam a qualidade composta, mas não substituem métricas.

## Métricas coletadas

Uma leitura v2 procura primeiro `modelId::v2::category::role` e, quando não encontra a categoria
exata, usa `modelId::taskKind::role`. A segunda chave permanece gravada e legível para compatibilidade
v1. Arquivos antigos são normalizados durante o parse; a próxima escrita persiste essa forma
normalizada. Assim, a adoção começa aproveitando o histórico existente sem misturar novas categorias.

Cada chave registra:

- tentativas e sucessos;
- duração acumulada;
- input e output tokens;
- custo estimado;
- falhas consecutivas;
- avaliações de qualidade;
- aprovações de qualidade.

A execução bem-sucedida mede apenas funcionamento. O quality gate mede utilidade do resultado. Os dois sinais são necessários.

## Hierarquia no dashboard

O painel existente agrupa as decisões pela raiz da categoria, na ordem em que aparecem nos artefatos.
Cada card continua mostrando o modelo, todos os scores e o fallback, e também exibe a categoria completa,
a versão da taxonomia e os features quando existirem.

## Fallback

A rota automática contém o selecionado e até três fallbacks. Os primeiros fallbacks priorizam providers ainda não usados, para reduzir falhas correlacionadas de uma única CLI. Todos os candidatos dessa lista finita podem ser tentados uma vez; `maxAttempts` permanece legível em workflows antigos, mas não corta essa lista. Uma rota com pin explícito não tem fallback.

Para tarefas mutáveis:

1. criar checkpoint Git;
2. executar candidato;
3. em falha, registrar métrica e artefato de tentativa;
4. resetar para o checkpoint;
5. executar próximo candidato.

A rota não é recalculada no meio do step. Isso preserva a explicabilidade da decisão original. O artefato distingue `selected`, `attemptedModelIds` e `executed`; sem essa separação, uma aprovação poderia alimentar métricas do modelo errado.

## Exploração versus exploração cega

O MVP é majoritariamente exploit: escolhe o melhor score conhecido. Em produção, isso pode congelar crenças iniciais ruins. Uma evolução responsável é usar exploração pequena e controlada:

- apenas em tarefas de baixo risco;
- com orçamento explícito;
- comparando resultado por avaliação cega;
- sem permitir que um modelo mais fraco altere produção diretamente.

Não use roleta aleatória em migração de banco e chame isso de aprendizado.

## Calibração recomendada

1. Colete 30 a 100 tarefas reais por classe.
2. Remova nomes de modelos dos artefatos para o reviewer.
3. Use testes determinísticos sempre que possível.
4. Registre intervenção humana e retrabalho posterior.
5. Compare taxa de aprovação, tempo total até aprovação e custo/quota.
6. Recalibre priors apenas quando a amostra justificar.
7. Versione o catálogo e anote a data da mudança.

## Falhas conhecidas

- Reviewer e produtor podem compartilhar os mesmos vieses.
- Contexto estimado por caracteres é grosseiro.
- Alias de CLI pode mudar o modelo real por baixo.
- Métricas locais podem sofrer selection bias.
- Uma aprovação imediata não captura defeitos descobertos dias depois.

A correção é adicionar sinais melhores, não adicionar mais casas decimais ao score.
