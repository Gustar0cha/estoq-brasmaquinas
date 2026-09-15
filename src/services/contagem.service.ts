import { uploadFotoContagem, obterFotoStream } from '../lib/minio';
import { prisma } from '../lib/prisma';
import {
  buscarProdutosSankhya,
  ehLocalDeQuarentena,
  getItemCopiaEstoque,
  getItensCopiaEstoquePorLocais,
  getLocaisComCopiaEstoque,
  getLocaisEsperadosDoProduto,
  ProdutoBuscaSankhya,
} from '../sankhya/client';
import { chavePredio, parsearLocalizacao } from '../sankhya/localizacao';
import {
  ehFilial,
  ehLocalDeLoja,
  Filial,
  filialDoLocal,
  labelFilial,
  localVisivelPara,
  prefixoDaFilial,
  PREFIXOS_DE_LOJA,
} from '../lib/filiais';
import { criarNotificacao, notificarUsuario } from './notificacao.service';

// DIVERGENCIA_LOCAL = o produto foi contado numa prateleira diferente da que
// o ERP esperava (item fora do lugar). É um status final próprio, e não um
// sabor de DIVERGENCIA, porque a providência do admin é outra: aqui o
// problema é endereçamento/etiqueta, não quantidade.
export type StatusContagemItem =
  | 'PENDENTE'
  | 'EM_ANDAMENTO'
  | 'CONFERIDA'
  | 'DIVERGENCIA'
  | 'DIVERGENCIA_LOCAL'
  | 'AGUARDANDO_SEGUNDA_CONTAGEM'
  | 'SEGUNDA_EM_ANDAMENTO';

const STATUS_ABERTOS: StatusContagemItem[] = [
  'PENDENTE',
  'EM_ANDAMENTO',
  'AGUARDANDO_SEGUNDA_CONTAGEM',
  'SEGUNDA_EM_ANDAMENTO',
];

export interface ContagemItemDTO {
  id: string;
  empresaCodigo: string;
  empresaNome: string;
  codigoProduto: string;
  descricao: string;
  unidade: string;
  local: string;
  localCodigo: string;
  quantidadeEsperada: number;
  dataCopiaEstoque?: string;
  status: StatusContagemItem;
  rua: string | null;
  predio: string | null;
  nivel: string | null;
  filial: Filial | null;
  divergenciaLocal: boolean;
  localEsperado?: string;
  atribuidoPara: string | null;
  atribuidoPorId?: string;
  atribuidoEm: string;
  iniciadoPorId?: string;
  iniciadoEm?: string;

  // 1ª contagem
  quantidadeConferida: number | null;
  diferenca: number | null;
  motivo?: string;
  observacao?: string;
  comentarioAdmin?: string;
  dataConferencia?: string;
  conferidoPorId?: string;
  codigoLocalBipado?: string;
  codigoProdutoBipado?: string;
  temFoto?: boolean;

  // 2ª contagem — só existe se foi solicitada pelo gestor
  segundaContagemSolicitada: boolean;
  segundaContagemAtribuidaPara?: string | null;
  segundaContagemIniciadaEm?: string;
  quantidadeConferida2?: number;
  diferenca2?: number;
  motivo2?: string;
  observacao2?: string;
  dataConferencia2?: string;
  conferidoPor2Id?: string;
  codigoLocalBipado2?: string;
  codigoProdutoBipado2?: string;
  temFoto2?: boolean;
}

export interface IniciarContagemItemInput {
  itemId: string;
  usuarioId: string;
  codigoProdutoBipado: string;
  codigoLocalBipado: string;
}

export interface EnviarContagemItemInput {
  itemId: string;
  conferidoPorId: string;
  quantidadeConferida: number;
  motivo?: string;
  observacao?: string;
  foto?: { buffer: Buffer; mimeType: string };
}

export interface FiltroContagemItens {
  status?: StatusContagemItem;
  atribuidoPara?: string;
  dataInicio?: Date;
  dataFim?: Date;
  // Loja de quem está pedindo: esconde da lista os locais das outras lojas
  // (o prefixo do CODLOCAL é que diz a filial — ver src/lib/filiais.ts).
  filial?: string | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function montarContagemItemDTO(item: any): ContagemItemDTO {
  const contagem2Registrada = item.quantidadeConferida2 !== null;
  // Enquanto ninguém terminou a 2ª contagem, quem deve ver o item na lista é
  // quem foi designado pra recontar — senão é quem o admin atribuiu pra 1ª
  // contagem (o "dono" da contagem em aberto).
  const atribuidoPara =
    item.segundaContagemSolicitada && !contagem2Registrada
      ? (item.segundaContagemUsuarioId ?? null)
      : (item.atribuidoParaId ?? null);

  return {
    id: item.id,
    empresaCodigo: item.empresaCodigo,
    empresaNome: item.empresaNome,
    codigoProduto: item.codigoProduto,
    descricao: item.descricao,
    unidade: item.unidade,
    local: item.local,
    localCodigo: item.localCodigo,
    quantidadeEsperada: item.quantidadeEsperada,
    dataCopiaEstoque: item.dataCopiaEstoque?.toISOString(),
    status: item.status,
    rua: item.rua ?? null,
    predio: item.predio ?? null,
    nivel: item.nivel ?? null,
    filial: filialDoLocal(item.localCodigo),
    divergenciaLocal: item.divergenciaLocal ?? false,
    localEsperado: item.localEsperado ?? undefined,
    atribuidoPara,
    atribuidoPorId: item.atribuidoPorId ?? undefined,
    atribuidoEm: item.atribuidoEm.toISOString(),
    iniciadoPorId: item.iniciadoPorId ?? undefined,
    iniciadoEm: item.iniciadoEm?.toISOString(),

    quantidadeConferida: item.quantidadeConferida,
    diferenca: item.diferenca,
    motivo: item.motivo ?? undefined,
    observacao: item.observacao ?? undefined,
    comentarioAdmin: item.comentarioAdmin ?? undefined,
    dataConferencia: item.dataConferencia?.toISOString(),
    conferidoPorId: item.conferidoPorId ?? undefined,
    codigoLocalBipado: item.codigoLocalBipado ?? undefined,
    codigoProdutoBipado: item.codigoProdutoBipado ?? undefined,
    temFoto: Boolean(item.fotoChaveArmazenamento),

    segundaContagemSolicitada: item.segundaContagemSolicitada,
    segundaContagemAtribuidaPara: item.segundaContagemUsuarioId ?? null,
    segundaContagemIniciadaEm: item.segundaContagemIniciadaEm?.toISOString(),
    quantidadeConferida2: item.quantidadeConferida2 ?? undefined,
    diferenca2: item.diferenca2 ?? undefined,
    motivo2: item.motivo2 ?? undefined,
    observacao2: item.observacao2 ?? undefined,
    dataConferencia2: item.dataConferencia2?.toISOString(),
    conferidoPor2Id: item.conferidoPor2Id ?? undefined,
    codigoLocalBipado2: item.codigoLocalBipado2 ?? undefined,
    codigoProdutoBipado2: item.codigoProdutoBipado2 ?? undefined,
    temFoto2: Boolean(item.fotoChaveArmazenamento2),
  };
}

async function nomeUsuario(usuarioId: string): Promise<string> {
  const usuario = await prisma.usuario.findUnique({ where: { id: usuarioId } });
  return usuario?.nome ?? 'Alguém';
}

// ---------------------------------------------------------------------------
// Descoberta de prédios (a partir da cópia de estoque já gerada no Sankhya)
// ---------------------------------------------------------------------------

export interface PredioDisponivel {
  rua: string | null;
  predio: string | null;
  filial: Filial | null;
  empresaCodigo: string;
  empresaNome: string;
  totalItens: number;
  totalLocais: number;
  locais: { localCodigo: string; local: string; nivel: string | null; totalItens: number }[];
  // Resumo por nível, pra o admin poder atribuir só um nível do prédio.
  niveis: { nivel: string | null; totalItens: number; totalLocais: number }[];
}

// Agrupa os locais que têm cópia de estoque (TGFCTE) por rua/prédio — é essa
// lista que o admin navega pra escolher o que atribuir. Locais sem rua/prédio
// reconhecível caem num grupo { rua: null, predio: null } ("Outros locais").
// Duas peneiras antes de agrupar:
//   1. endereçamento antigo fica de fora (ver ehLocalDeLoja) — senão um
//      prédio novo vem inflado com dezenas de prateleiras velhas que têm
//      "R.1"/"P.1" no nome;
//   2. `filial` esconde os locais das outras lojas, pra quem tem loja
//      definida no cadastro.
export async function getPrediosDisponiveis(
  empresa?: string,
  filial?: string | null
): Promise<PredioDisponivel[]> {
  const todosOsLocais = await getLocaisComCopiaEstoque(empresa);
  const locais = todosOsLocais.filter(
    (l) => ehLocalDeLoja(l.localCodigo) && localVisivelPara(l.localCodigo, filial)
  );
  const grupos = new Map<string, PredioDisponivel>();

  for (const local of locais) {
    const { rua, predio } = parsearLocalizacao(local.local);
    const filialDoGrupo = filialDoLocal(local.localCodigo);
    const chave = `${local.empresaCodigo}|${filialDoGrupo ?? '-'}|${chavePredio(rua, predio)}`;
    let grupo = grupos.get(chave);
    if (!grupo) {
      grupo = {
        rua,
        predio,
        filial: filialDoGrupo,
        empresaCodigo: local.empresaCodigo,
        empresaNome: local.empresaNome,
        totalItens: 0,
        totalLocais: 0,
        locais: [],
        niveis: [],
      };
      grupos.set(chave, grupo);
    }
    grupo.totalItens += local.totalItens;
    grupo.totalLocais += 1;
    const { nivel } = parsearLocalizacao(local.local);
    grupo.locais.push({ localCodigo: local.localCodigo, local: local.local, nivel, totalItens: local.totalItens });
    const resumoNivel = grupo.niveis.find((n) => n.nivel === nivel);
    if (resumoNivel) {
      resumoNivel.totalItens += local.totalItens;
      resumoNivel.totalLocais += 1;
    } else {
      grupo.niveis.push({ nivel, totalItens: local.totalItens, totalLocais: 1 });
    }
  }

  for (const grupo of grupos.values()) {
    grupo.niveis.sort((a, b) => Number(a.nivel ?? 9999) - Number(b.nivel ?? 9999));
  }

  return Array.from(grupos.values()).sort((a, b) => {
    if (a.empresaCodigo !== b.empresaCodigo) return a.empresaCodigo.localeCompare(b.empresaCodigo);
    if (a.filial !== b.filial) return (a.filial ?? 'zzz').localeCompare(b.filial ?? 'zzz');
    if (a.rua !== b.rua) return (a.rua ?? 'zzz').localeCompare(b.rua ?? 'zzz');
    return (a.predio ?? 'zzz').localeCompare(b.predio ?? 'zzz');
  });
}

// ---------------------------------------------------------------------------
// Atribuição (admin distribui um prédio inteiro pra um colaborador contar)
// ---------------------------------------------------------------------------

export interface AtribuirContagemPredioInput {
  rua: string | null;
  predio: string | null;
  // Opcional: atribui só um nível do prédio. undefined = prédio inteiro;
  // null = só os locais do prédio que não trazem nível no nome.
  nivel?: string | null;
  filial?: string | null;
  empresaCodigo: string;
  atribuidoParaId: string;
  atribuidoPorId: string;
}

// Ninguém recebe prateleira de outra loja: se o colaborador tem filial
// definida, o prédio atribuído precisa ser da mesma filial.
async function exigirFilialCompativel(usuarioId: string, filialDoPredio: Filial | null): Promise<void> {
  const usuario = await prisma.usuario.findUnique({ where: { id: usuarioId } });
  if (!usuario) throw new Error('Colaborador não encontrado.');
  if (!ehFilial(usuario.filial)) return;
  if (usuario.filial !== filialDoPredio) {
    throw new Error(
      `${usuario.nome} é da loja ${labelFilial(usuario.filial)} e esse local é de ${labelFilial(filialDoPredio)}.`
    );
  }
}

export async function atribuirContagemPredio(
  input: AtribuirContagemPredioInput
): Promise<{ criados: number }> {
  const predios = await getPrediosDisponiveis(input.empresaCodigo);
  const grupo = predios.find(
    (p) =>
      p.rua === input.rua &&
      p.predio === input.predio &&
      (input.filial === undefined || p.filial === (input.filial ?? null))
  );
  if (!grupo) {
    throw new Error('Não há cópia de estoque registrada pra esse prédio.');
  }

  await exigirFilialCompativel(input.atribuidoParaId, grupo.filial);

  const locaisAlvo =
    input.nivel === undefined ? grupo.locais : grupo.locais.filter((l) => l.nivel === input.nivel);
  if (locaisAlvo.length === 0) {
    throw new Error('Esse nível não tem itens na cópia de estoque.');
  }

  const itensCopia = await getItensCopiaEstoquePorLocais(
    locaisAlvo.map((l) => l.localCodigo),
    input.empresaCodigo
  );

  const existentes = await prisma.contagemItem.findMany({
    where: { empresaCodigo: input.empresaCodigo, status: { in: STATUS_ABERTOS } },
    select: { codigoProduto: true, localCodigo: true },
  });
  const chavesExistentes = new Set(existentes.map((e) => `${e.codigoProduto}|${e.localCodigo}`));
  const novos = itensCopia.filter((i) => !chavesExistentes.has(`${i.codigoProduto}|${i.localCodigo}`));

  if (novos.length === 0) {
    return { criados: 0 };
  }

  await prisma.contagemItem.createMany({
    data: novos.map((i) => ({
      empresaCodigo: i.empresaCodigo,
      empresaNome: i.empresaNome,
      codigoProduto: i.codigoProduto,
      descricao: i.descricao,
      unidade: i.unidade,
      local: i.local,
      localCodigo: i.localCodigo,
      quantidadeEsperada: i.quantidadeEsperada,
      dataCopiaEstoque: i.dataCopiaEstoque ? new Date(i.dataCopiaEstoque) : null,
      status: 'PENDENTE',
      rua: input.rua,
      predio: input.predio,
      nivel: parsearLocalizacao(i.local).nivel,
      atribuidoParaId: input.atribuidoParaId,
      atribuidoPorId: input.atribuidoPorId,
    })),
  });

  const nomeAdmin = await nomeUsuario(input.atribuidoPorId);
  const rotulo =
    `Rua ${input.rua ?? '?'} Prédio ${input.predio ?? '?'}` +
    (input.nivel !== undefined ? ` Nível ${input.nivel ?? '?'}` : '');
  await notificarUsuario(
    'ATRIBUICAO_CONTAGEM',
    `${input.empresaCodigo}|${chavePredio(input.rua, input.predio)}`,
    'Nova contagem atribuída',
    `${nomeAdmin} atribuiu ${rotulo} pra você contar (${novos.length} ite${novos.length === 1 ? 'm' : 'ns'}).`,
    input.atribuidoParaId
  );

  return { criados: novos.length };
}

// ---------------------------------------------------------------------------
// Gestão da atribuição (repassar pra outro operador / remover)
// ---------------------------------------------------------------------------

// Itens que ainda não produziram nenhum número contado — os únicos que podem
// ser repassados ou removidos sem jogar trabalho fora. Um item já conferido
// (ou em 2ª contagem) fica onde está, com quem contou.
const STATUS_SEM_CONTAGEM: StatusContagemItem[] = ['PENDENTE', 'EM_ANDAMENTO'];

export interface AlvoAtribuicaoPredio {
  rua: string | null;
  predio: string | null;
  empresaCodigo: string;
  filial?: string | null;
  // Só os locais FORA do endereçamento atual. Sem isso, remover "Rua 1
  // Prédio 6" levaria junto o prédio novo de mesmo nome, já que rua/prédio
  // sozinhos não distinguem os dois endereçamentos.
  somenteLegado?: boolean;
  // Opcional: restringe a ação aos itens de UM colaborador só (um prédio
  // pode estar dividido entre mais de uma pessoa).
  deUsuarioId?: string | null;
}

// Recorte de local comum a todas as ações de prédio: por loja, ou só o que
// está fora do endereçamento atual.
function filtroDeLocal(alvo: AlvoAtribuicaoPredio) {
  if (alvo.somenteLegado) {
    return { NOT: { OR: PREFIXOS_DE_LOJA.map((prefixo) => ({ localCodigo: { startsWith: prefixo } })) } };
  }
  if (ehFilial(alvo.filial)) {
    return { localCodigo: { startsWith: prefixoDaFilial(alvo.filial) } };
  }
  return {};
}

function whereDoPredio(alvo: AlvoAtribuicaoPredio) {
  return {
    empresaCodigo: alvo.empresaCodigo,
    rua: alvo.rua,
    predio: alvo.predio,
    status: { in: STATUS_SEM_CONTAGEM },
    ...filtroDeLocal(alvo),
    ...(alvo.deUsuarioId ? { atribuidoParaId: alvo.deUsuarioId } : {}),
  };
}

function rotuloPredio(rua: string | null, predio: string | null): string {
  if (!rua && !predio) return 'Outros locais';
  return `Rua ${rua ?? '?'}${predio ? ` Prédio ${predio}` : ''}`;
}

export interface ReatribuirContagemPredioInput extends AlvoAtribuicaoPredio {
  paraUsuarioId: string;
  reatribuidoPorId: string;
}

// Tira a contagem de quem está com ela e entrega pra outro operador na mesma
// hora. Os itens voltam pra PENDENTE (mesmo os que já tinham sido bipados),
// porque quem assume precisa ir até a prateleira e bipar por conta própria —
// o bipe é a prova de presença física, não pode ser herdado.
export async function reatribuirContagemPredio(
  input: ReatribuirContagemPredioInput
): Promise<{ movidos: number }> {
  const itens = await prisma.contagemItem.findMany({
    where: whereDoPredio(input),
    select: { id: true, atribuidoParaId: true, localCodigo: true },
  });

  if (itens.length === 0) {
    throw new Error('Não há itens em aberto pra repassar nesse prédio.');
  }

  await exigirFilialCompativel(input.paraUsuarioId, filialDoLocal(itens[0].localCodigo));

  await prisma.contagemItem.updateMany({
    where: { id: { in: itens.map((i) => i.id) } },
    data: {
      atribuidoParaId: input.paraUsuarioId,
      atribuidoPorId: input.reatribuidoPorId,
      atribuidoEm: new Date(),
      status: 'PENDENTE',
      iniciadoPorId: null,
      iniciadoEm: null,
      codigoProdutoBipado: null,
      codigoLocalBipado: null,
    },
  });

  const rotulo = rotuloPredio(input.rua, input.predio);
  const nomeAdmin = await nomeUsuario(input.reatribuidoPorId);
  const nomeNovo = await nomeUsuario(input.paraUsuarioId);
  const chave = `${input.empresaCodigo}|${chavePredio(input.rua, input.predio)}`;

  await notificarUsuario(
    'ATRIBUICAO_CONTAGEM',
    chave,
    'Contagem repassada pra você',
    `${nomeAdmin} passou ${rotulo} pra você contar (${itens.length} ite${itens.length === 1 ? 'm' : 'ns'}).`,
    input.paraUsuarioId
  );

  const anteriores = new Set(
    itens
      .map((i) => i.atribuidoParaId)
      .filter((id): id is string => Boolean(id) && id !== input.paraUsuarioId)
  );
  for (const anteriorId of anteriores) {
    await notificarUsuario(
      'ATRIBUICAO_CONTAGEM',
      chave,
      'Contagem repassada',
      `${nomeAdmin} passou ${rotulo} pra ${nomeNovo}. Você não precisa mais contar esse prédio.`,
      anteriorId
    );
  }

  return { movidos: itens.length };
}

export interface RemoverAtribuicaoPredioInput extends AlvoAtribuicaoPredio {
  removidoPorId: string;
  // true = limpeza total do prédio, incluindo o que já foi contado (a
  // contagem e a foto somem junto, sem volta). false/ausente = só tira da
  // lista o que ninguém contou.
  incluirContados?: boolean;
}

// Remove a atribuição. O que ninguém contou é apagado (e é recriado
// igualzinho a partir da cópia de estoque numa próxima atribuição). O que já
// foi contado só sai com `incluirContados` — senão fica registrado, e
// `mantidos` diz quantos ficaram.
export async function removerAtribuicaoPredio(
  input: RemoverAtribuicaoPredioInput
): Promise<{ removidos: number; mantidos: number }> {
  const emAberto = await prisma.contagemItem.findMany({
    where: whereDoPredio(input),
    select: { id: true, atribuidoParaId: true },
  });

  const whereContados = {
    empresaCodigo: input.empresaCodigo,
    rua: input.rua,
    predio: input.predio,
    status: { notIn: STATUS_SEM_CONTAGEM },
    ...filtroDeLocal(input),
    ...(input.deUsuarioId ? { atribuidoParaId: input.deUsuarioId } : {}),
  };
  const contados = input.incluirContados
    ? await prisma.contagemItem.findMany({ where: whereContados, select: { id: true, atribuidoParaId: true } })
    : [];
  const mantidos = input.incluirContados
    ? 0
    : await prisma.contagemItem.count({ where: whereContados });

  const itens = [...emAberto, ...contados];
  if (itens.length === 0) {
    throw new Error('Não há itens pra remover nesse prédio.');
  }

  await prisma.contagemItem.deleteMany({ where: { id: { in: itens.map((i) => i.id) } } });

  const rotulo = rotuloPredio(input.rua, input.predio);
  const nomeAdmin = await nomeUsuario(input.removidoPorId);
  const chave = `${input.empresaCodigo}|${chavePredio(input.rua, input.predio)}`;
  const anteriores = new Set(itens.map((i) => i.atribuidoParaId).filter((id): id is string => Boolean(id)));
  for (const anteriorId of anteriores) {
    await notificarUsuario(
      'ATRIBUICAO_CONTAGEM',
      chave,
      'Contagem cancelada',
      `${nomeAdmin} removeu ${rotulo} da sua lista de contagem.` +
        (input.incluirContados ? ' As contagens já registradas desse prédio foram apagadas.' : ''),
      anteriorId
    );
  }

  return { removidos: itens.length, mantidos };
}

// ---------------------------------------------------------------------------
// Item fora do lugar (produto intruso na prateleira que está sendo contada)
// ---------------------------------------------------------------------------

export async function buscarProdutos(termo: string): Promise<ProdutoBuscaSankhya[]> {
  return buscarProdutosSankhya(termo);
}

export interface RegistrarItemForaDoLugarInput {
  usuarioId: string;
  codigoProduto: string;
  codigoLocalBipado: string;
  codigoProdutoBipado: string;
}

// O filtro por loja não pode engessar a operação: é comum achar produto
// guardado no lugar errado. Aqui o colaborador registra o que encontrou na
// prateleira em que ele está — o item entra na contagem dele na hora, e se o
// ERP esperava aquele produto em outro endereço ele nasce marcado como
// divergência de local, pro admin resolver o endereçamento/etiqueta.
export async function registrarItemForaDoLugar(
  input: RegistrarItemForaDoLugarInput
): Promise<ContagemItemDTO> {
  const usuario = await prisma.usuario.findUnique({ where: { id: input.usuarioId } });
  if (!usuario) throw new Error('Usuário não encontrado.');

  if (!localVisivelPara(input.codigoLocalBipado, usuario.filial)) {
    throw new Error(
      `O local ${input.codigoLocalBipado} não é da loja ${labelFilial(usuario.filial)} — confira a etiqueta.`
    );
  }

  const base = await getItemCopiaEstoque(input.codigoProduto, input.codigoLocalBipado);
  if (!base) {
    throw new Error('Não achei esse produto ou esse local no Sankhya. Confira os códigos.');
  }
  if (ehLocalDeQuarentena(base.local)) {
    throw new Error(`${base.local} é área de quarentena — produto em quarentena não entra na contagem.`);
  }

  const jaExiste = await prisma.contagemItem.findFirst({
    where: {
      codigoProduto: base.codigoProduto,
      localCodigo: base.localCodigo,
      empresaCodigo: base.empresaCodigo,
      status: { in: STATUS_ABERTOS },
    },
  });
  if (jaExiste) {
    if (jaExiste.atribuidoParaId !== input.usuarioId) {
      const dono = await nomeUsuario(jaExiste.atribuidoParaId ?? '');
      throw new Error(`Esse produto já está na contagem de ${dono} nesse mesmo local.`);
    }
    return montarContagemItemDTO(jaExiste);
  }

  const locaisEsperados = await getLocaisEsperadosDoProduto(base.codigoProduto, base.empresaCodigo);
  const esperadoAqui =
    base.quantidadeEsperada > 0 || locaisEsperados.some((l) => l.localCodigo === base.localCodigo);
  const outrosLocais = locaisEsperados.filter((l) => l.localCodigo !== base.localCodigo);
  const divergenciaLocal = !esperadoAqui;
  const localEsperado = outrosLocais.length > 0 ? outrosLocais.map((l) => l.local).join(' | ') : null;

  const { rua, predio, nivel } = parsearLocalizacao(base.local);

  const criado = await prisma.contagemItem.create({
    data: {
      empresaCodigo: base.empresaCodigo,
      empresaNome: base.empresaNome,
      codigoProduto: base.codigoProduto,
      descricao: base.descricao,
      unidade: base.unidade,
      local: base.local,
      localCodigo: base.localCodigo,
      quantidadeEsperada: base.quantidadeEsperada,
      dataCopiaEstoque: base.dataCopiaEstoque ? new Date(base.dataCopiaEstoque) : null,
      rua,
      predio,
      nivel,
      divergenciaLocal,
      localEsperado,
      // Já nasce em andamento: o colaborador está com o item na mão e acabou
      // de bipar o local, então segue direto pra digitar a quantidade.
      status: 'EM_ANDAMENTO',
      atribuidoParaId: input.usuarioId,
      atribuidoPorId: input.usuarioId,
      iniciadoPorId: input.usuarioId,
      iniciadoEm: new Date(),
      codigoProdutoBipado: input.codigoProdutoBipado,
      codigoLocalBipado: input.codigoLocalBipado,
    },
  });

  const nome = await nomeUsuario(input.usuarioId);
  if (divergenciaLocal) {
    await criarNotificacao(
      'DIVERGENCIA_LOCAL',
      criado.id,
      'Divergência de local',
      `${nome} achou ${base.descricao} em ${base.local}` +
        (localEsperado
          ? `, mas o sistema esperava em ${localEsperado}.`
          : ', local que o sistema não tinha registrado.')
    );
  } else {
    await criarNotificacao(
      'INICIO_CONTAGEM',
      criado.id,
      'Contagem iniciada',
      `${nome} começou a contar ${base.descricao} (${base.local}) — item que não estava na lista dele.`
    );
  }

  return montarContagemItemDTO(criado);
}

// ---------------------------------------------------------------------------
// Bipe validado (colaborador confirma um item já atribuído)
// ---------------------------------------------------------------------------

// O item já existe (PENDENTE, atribuído pelo admin) — aqui só confirma, por
// bipe, que o colaborador está de fato no local esperado. Só valida o LOCAL
// (a etiqueta de prateleira é gerada pelo próprio WMS/Sankhya, então o
// código bipado bate direto com CODLOCAL). O código de produto bipado é só
// evidência, não validação: os produtos aqui não têm CODBARRA cadastrado no
// Sankhya, então o que a câmera lê é o código de barras real do fabricante
// (ex: EAN-13 impresso pela TETIS/WEG/etc), que nunca vai bater com o código
// interno do produto (CODPROD) — comparar os dois bloquearia bipes 100%
// corretos.
export async function iniciarContagemItem(input: IniciarContagemItemInput): Promise<ContagemItemDTO> {
  const item = await prisma.contagemItem.findUnique({ where: { id: input.itemId } });
  if (!item) {
    throw new Error('Item de contagem não encontrado.');
  }
  if (item.status !== 'PENDENTE' || item.atribuidoParaId !== input.usuarioId) {
    throw new Error('Esse item não está atribuído a você.');
  }
  if (ehLocalDeQuarentena(item.local)) {
    throw new Error(`${item.local} é área de quarentena — produto em quarentena não entra na contagem.`);
  }
  if (input.codigoLocalBipado !== item.localCodigo) {
    throw new Error(
      `Esse local não é ${item.local} — confira a etiqueta do local antes de continuar.`
    );
  }

  const atualizado = await prisma.contagemItem.update({
    where: { id: item.id },
    data: {
      status: 'EM_ANDAMENTO',
      iniciadoPorId: input.usuarioId,
      iniciadoEm: new Date(),
      codigoProdutoBipado: input.codigoProdutoBipado,
      codigoLocalBipado: input.codigoLocalBipado,
    },
  });

  const nome = await nomeUsuario(input.usuarioId);
  await criarNotificacao(
    'INICIO_CONTAGEM',
    item.id,
    'Contagem iniciada',
    `${nome} começou a contar ${item.descricao} (${item.local}).`
  );

  return montarContagemItemDTO(atualizado);
}

// O gestor já escolheu quem faz a recontagem (solicitarSegundaContagemItem);
// aqui é o colaborador designado bipando de novo pra confirmar fisicamente
// que foi até o local antes de poder enviar a 2ª contagem — mesma validação
// de local (só local, ver comentário em iniciarContagemItem) que a 1ª
// contagem.
export async function iniciarSegundaContagemItem(
  itemId: string,
  usuarioId: string,
  codigoProdutoBipado: string,
  codigoLocalBipado: string
): Promise<ContagemItemDTO> {
  const item = await prisma.contagemItem.findUnique({ where: { id: itemId } });
  if (!item) {
    throw new Error('Item de contagem não encontrado.');
  }
  if (!item.segundaContagemSolicitada || item.segundaContagemUsuarioId !== usuarioId) {
    throw new Error('Você não foi designado pra recontar esse item.');
  }
  if (item.quantidadeConferida2 !== null) {
    throw new Error('A 2ª contagem desse item já foi registrada.');
  }
  if (codigoLocalBipado !== item.localCodigo) {
    throw new Error(
      `Esse local não é ${item.local} — confira a etiqueta do local antes de continuar.`
    );
  }

  const atualizado = await prisma.contagemItem.update({
    where: { id: itemId },
    data: {
      status: 'SEGUNDA_EM_ANDAMENTO',
      segundaContagemIniciadaEm: new Date(),
      codigoProdutoBipado2: codigoProdutoBipado,
      codigoLocalBipado2: codigoLocalBipado,
    },
  });

  const nome = await nomeUsuario(usuarioId);
  await criarNotificacao(
    'INICIO_SEGUNDA_CONTAGEM',
    item.id,
    'Recontagem iniciada',
    `${nome} começou a recontar ${item.descricao} (${item.local}).`
  );

  return montarContagemItemDTO(atualizado);
}

export async function getContagemItens(filtro?: FiltroContagemItens): Promise<ContagemItemDTO[]> {
  const itens = await prisma.contagemItem.findMany({
    where: {
      ...(filtro?.status ? { status: filtro.status } : {}),
      ...(ehFilial(filtro?.filial)
        ? { localCodigo: { startsWith: prefixoDaFilial(filtro.filial) } }
        : {}),
      ...(filtro?.dataInicio || filtro?.dataFim
        ? {
            iniciadoEm: {
              ...(filtro?.dataInicio ? { gte: filtro.dataInicio } : {}),
              ...(filtro?.dataFim ? { lte: filtro.dataFim } : {}),
            },
          }
        : {}),
    },
    orderBy: { atribuidoEm: 'desc' },
  });

  const dtos = itens.map(montarContagemItemDTO);
  return filtro?.atribuidoPara ? dtos.filter((i) => i.atribuidoPara === filtro.atribuidoPara) : dtos;
}

export async function getDivergenciasContagem(filtro?: {
  dataInicio?: Date;
  dataFim?: Date;
  filial?: string | null;
}): Promise<ContagemItemDTO[]> {
  const [divergentes, divergenciasDeLocal, aguardando, segundaEmAndamento] = await Promise.all([
    getContagemItens({ ...filtro, status: 'DIVERGENCIA' }),
    getContagemItens({ ...filtro, status: 'DIVERGENCIA_LOCAL' }),
    getContagemItens({ ...filtro, status: 'AGUARDANDO_SEGUNDA_CONTAGEM' }),
    getContagemItens({ ...filtro, status: 'SEGUNDA_EM_ANDAMENTO' }),
  ]);
  return [...divergentes, ...divergenciasDeLocal, ...aguardando, ...segundaEmAndamento];
}

export async function getContagemItem(id: string): Promise<ContagemItemDTO | null> {
  const item = await prisma.contagemItem.findUnique({ where: { id } });
  return item ? montarContagemItemDTO(item) : null;
}

export async function enviarContagemItem(input: EnviarContagemItemInput): Promise<ContagemItemDTO> {
  const item = await prisma.contagemItem.findUnique({ where: { id: input.itemId } });
  if (!item) {
    throw new Error(`Item de contagem ${input.itemId} não encontrado.`);
  }

  const numeroContagem = item.status === 'SEGUNDA_EM_ANDAMENTO' ? 2 : 1;
  if (numeroContagem === 1 && item.status !== 'EM_ANDAMENTO') {
    throw new Error('Essa contagem já foi enviada.');
  }

  const diferenca = input.quantidadeConferida - item.quantidadeEsperada;
  // Item fora do lugar quase sempre diverge (o sistema esperava 0 ali), e o
  // motivo já é conhecido — não faz sentido cobrar do colaborador.
  const motivo = item.divergenciaLocal
    ? (input.motivo ?? 'Item encontrado em local diferente do sistema')
    : input.motivo;
  if (diferenca !== 0 && !motivo) {
    throw new Error('Motivo é obrigatório quando a contagem diverge do esperado.');
  }

  let fotoChave: string | undefined;
  if (input.foto) {
    fotoChave = await uploadFotoContagem(item.id, numeroContagem, input.foto.buffer, input.foto.mimeType);
  }

  const novoStatus: StatusContagemItem = item.divergenciaLocal
    ? 'DIVERGENCIA_LOCAL'
    : diferenca === 0
      ? 'CONFERIDA'
      : 'DIVERGENCIA';

  await prisma.contagemItem.update({
    where: { id: item.id },
    data:
      numeroContagem === 1
        ? {
            quantidadeConferida: input.quantidadeConferida,
            diferenca,
            motivo: diferenca !== 0 ? motivo : null,
            observacao: input.observacao ?? null,
            conferidoPorId: input.conferidoPorId,
            dataConferencia: new Date(),
            status: novoStatus,
            ...(fotoChave ? { fotoChaveArmazenamento: fotoChave } : {}),
          }
        : {
            quantidadeConferida2: input.quantidadeConferida,
            diferenca2: diferenca,
            motivo2: diferenca !== 0 ? motivo : null,
            observacao2: input.observacao ?? null,
            conferidoPor2Id: input.conferidoPorId,
            dataConferencia2: new Date(),
            segundaContagemSolicitada: false,
            status: novoStatus,
            ...(fotoChave ? { fotoChaveArmazenamento2: fotoChave } : {}),
          },
  });

  const nome = await nomeUsuario(input.conferidoPorId);
  const rotulo = numeroContagem === 1 ? '' : ' (2ª contagem)';
  if (item.divergenciaLocal) {
    await criarNotificacao(
      'DIVERGENCIA_LOCAL',
      item.id,
      'Divergência de local',
      `${nome} contou ${input.quantidadeConferida} de ${item.descricao} em ${item.local}` +
        (item.localEsperado ? `, mas o sistema esperava esse produto em ${item.localEsperado}.` : '.')
    );
  } else if (diferenca === 0) {
    await criarNotificacao(
      'FIM_CONTAGEM',
      item.id,
      numeroContagem === 1 ? 'Contagem concluída' : 'Recontagem concluída',
      `${nome} contou ${item.descricao} (${item.local})${rotulo}: bateu com a cópia de estoque.`
    );
  } else {
    await criarNotificacao(
      'DIVERGENCIA_CONTAGEM',
      item.id,
      numeroContagem === 1 ? 'Divergência na contagem de estoque' : 'Divergência na recontagem',
      `${nome} contou ${item.descricao} (${item.local})${rotulo}: esperado ${item.quantidadeEsperada}, contado ${input.quantidadeConferida}.`
    );
  }

  const dto = await getContagemItem(item.id);
  if (!dto) throw new Error('Falha ao recarregar item de contagem.');
  return dto;
}

export async function comentarDivergenciaContagemItem(
  id: string,
  comentarioAdmin: string
): Promise<ContagemItemDTO | null> {
  const item = await prisma.contagemItem.update({ where: { id }, data: { comentarioAdmin } });
  return montarContagemItemDTO(item);
}

export async function solicitarSegundaContagemContagemItem(
  id: string,
  solicitadoPorId: string,
  usuarioId: string
): Promise<ContagemItemDTO | null> {
  const item = await prisma.contagemItem.update({
    where: { id },
    data: {
      segundaContagemSolicitada: true,
      segundaContagemSolicitadaPorId: solicitadoPorId,
      segundaContagemUsuarioId: usuarioId,
      status: 'AGUARDANDO_SEGUNDA_CONTAGEM',
    },
  });
  return montarContagemItemDTO(item);
}

export async function getFotoContagemItem(id: string, numeroContagem: number) {
  const item = await prisma.contagemItem.findUnique({ where: { id } });
  const chave = numeroContagem === 2 ? item?.fotoChaveArmazenamento2 : item?.fotoChaveArmazenamento;
  if (!chave) return null;
  return obterFotoStream(chave);
}

export interface IndicadoresContagemDTO {
  pendente: number;
  emAndamento: number;
  conferidos: number;
  comDivergencia: number;
  divergenciaLocal: number;
  aguardandoSegundaContagem: number;
  segundaEmAndamento: number;
}

export async function getIndicadoresContagem(filial?: string | null): Promise<IndicadoresContagemDTO> {
  const grupos = await prisma.contagemItem.groupBy({
    by: ['status'],
    _count: { _all: true },
    where: ehFilial(filial) ? { localCodigo: { startsWith: prefixoDaFilial(filial) } } : {},
  });
  const mapa = Object.fromEntries(grupos.map((g) => [g.status, g._count._all]));

  return {
    pendente: mapa.PENDENTE ?? 0,
    emAndamento: mapa.EM_ANDAMENTO ?? 0,
    conferidos: mapa.CONFERIDA ?? 0,
    comDivergencia: mapa.DIVERGENCIA ?? 0,
    divergenciaLocal: mapa.DIVERGENCIA_LOCAL ?? 0,
    aguardandoSegundaContagem: mapa.AGUARDANDO_SEGUNDA_CONTAGEM ?? 0,
    segundaEmAndamento: mapa.SEGUNDA_EM_ANDAMENTO ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Monitoramento em tempo real por prédio
// ---------------------------------------------------------------------------

export interface ProgressoPredioColaborador {
  usuarioId: string;
  nome: string;
  itensEmAberto: number;
}

export interface ProgressoPredio {
  rua: string | null;
  predio: string | null;
  filial: Filial | null;
  empresaCodigo: string;
  empresaNome: string;
  total: number;
  pendente: number;
  emAndamento: number;
  conferido: number;
  divergente: number;
  divergenciaLocal: number;
  colaboradores: ProgressoPredioColaborador[];
}

export async function getProgressoContagemPorPredio(filial?: string | null): Promise<ProgressoPredio[]> {
  const itens = await prisma.contagemItem.findMany({
    where: ehFilial(filial) ? { localCodigo: { startsWith: prefixoDaFilial(filial) } } : {},
    select: {
      rua: true,
      predio: true,
      localCodigo: true,
      empresaCodigo: true,
      empresaNome: true,
      status: true,
      atribuidoParaId: true,
      segundaContagemUsuarioId: true,
      segundaContagemSolicitada: true,
      quantidadeConferida2: true,
    },
  });

  const usuarioIds = new Set<string>();
  const grupos = new Map<string, ProgressoPredio>();

  for (const item of itens) {
    // A filial entra na chave pra não juntar num grupo só o prédio novo e as
    // prateleiras antigas que têm o mesmo "R.1/P.6" no nome.
    const chave = `${item.empresaCodigo}|${filialDoLocal(item.localCodigo) ?? '-'}|${chavePredio(item.rua, item.predio)}`;
    let grupo = grupos.get(chave);
    if (!grupo) {
      grupo = {
        rua: item.rua,
        predio: item.predio,
        filial: filialDoLocal(item.localCodigo),
        empresaCodigo: item.empresaCodigo,
        empresaNome: item.empresaNome,
        total: 0,
        pendente: 0,
        emAndamento: 0,
        conferido: 0,
        divergente: 0,
        divergenciaLocal: 0,
        colaboradores: [],
      };
      grupos.set(chave, grupo);
    }

    grupo.total += 1;
    if (item.status === 'PENDENTE') grupo.pendente += 1;
    if (item.status === 'EM_ANDAMENTO' || item.status === 'SEGUNDA_EM_ANDAMENTO') grupo.emAndamento += 1;
    if (item.status === 'CONFERIDA') grupo.conferido += 1;
    if (item.status === 'DIVERGENCIA' || item.status === 'AGUARDANDO_SEGUNDA_CONTAGEM') grupo.divergente += 1;
    if (item.status === 'DIVERGENCIA_LOCAL') grupo.divergenciaLocal += 1;

    const responsavel =
      item.segundaContagemSolicitada && item.quantidadeConferida2 === null
        ? item.segundaContagemUsuarioId
        : item.atribuidoParaId;
    if (responsavel && STATUS_ABERTOS.includes(item.status as StatusContagemItem)) {
      usuarioIds.add(responsavel);
    }
  }

  const usuarios = await prisma.usuario.findMany({ where: { id: { in: Array.from(usuarioIds) } } });
  const nomePorId = new Map(usuarios.map((u) => [u.id, u.nome]));

  // Segunda passada só pra montar a contagem de itens em aberto por colaborador.
  for (const [chave, grupo] of grupos) {
    const itensDoGrupo = itens.filter(
      (i) =>
        `${i.empresaCodigo}|${filialDoLocal(i.localCodigo) ?? '-'}|${chavePredio(i.rua, i.predio)}` === chave
    );
    const contagemPorUsuario = new Map<string, number>();
    for (const item of itensDoGrupo) {
      if (!STATUS_ABERTOS.includes(item.status as StatusContagemItem)) continue;
      const responsavel =
        item.segundaContagemSolicitada && item.quantidadeConferida2 === null
          ? item.segundaContagemUsuarioId
          : item.atribuidoParaId;
      if (!responsavel) continue;
      contagemPorUsuario.set(responsavel, (contagemPorUsuario.get(responsavel) ?? 0) + 1);
    }
    grupo.colaboradores = Array.from(contagemPorUsuario.entries()).map(([usuarioId, itensEmAberto]) => ({
      usuarioId,
      nome: nomePorId.get(usuarioId) ?? 'Alguém',
      itensEmAberto,
    }));
  }

  return Array.from(grupos.values()).sort((a, b) => {
    if (a.empresaCodigo !== b.empresaCodigo) return a.empresaCodigo.localeCompare(b.empresaCodigo);
    if (a.rua !== b.rua) return (a.rua ?? 'zzz').localeCompare(b.rua ?? 'zzz');
    return (a.predio ?? 'zzz').localeCompare(b.predio ?? 'zzz');
  });
}
