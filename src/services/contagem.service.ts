import { ehLocalPaiAgrupador } from '../lib/agrupadores';
import { uploadFotoContagem, obterFotoStream } from '../lib/minio';
import { prisma } from '../lib/prisma';
import {
  buscarProdutosSankhya,
  codigoBipadoIdentificaProduto,
  ehLocalDeQuarentena,
  getLocaisEsperadosDoProduto,
  getProdutoPorCodigoBarras,
  getPaiDoLocal,
  ProdutoBuscaSankhya,
  chaveCusto,
  getCustosSemIcms,
} from '../sankhya/client';
import {
  getItensComSaldoPorLocais,
  getLocaisComSaldo,
  getPedidosQueReservam,
  getItemForaDoLugar,
  getSaldoTotalDoProduto,
  PedidoQueReserva,
} from '../sankhya/estoque';
import {
  chavePredio,
  resolverLocalizacao,
  rotuloDaSubdivisao,
  rotuloDoGrupo,
} from '../sankhya/localizacao';
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
import { garantirCicloAberto } from './ciclo.service';
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
  // Inventário a que o item pertence.
  cicloId: string | null;
  // Conferida contra o DISPONÍVEL (total - reservado): o item reservado já
  // foi separado pra um pedido e não deveria mais estar na prateleira.
  quantidadeEsperada: number;
  quantidadeTotal: number | null;
  quantidadeReservada: number;
  dataSaldo?: string;
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
  tarefaId: string | null;
  tarefaNome: string | null;
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
  // Inventário. Ausente = todos.
  cicloId?: string;
  // Recorte por tarefa — é o que separa o inventário da movimentação diária
  // e um lote de trabalho do outro. Várias tarefas somam.
  tarefaIds?: string[];
  // Esconde o que pertence a inventário já fechado. É o que a tela do
  // operador usa: contagem encerrada não é mais trabalho de ninguém, e ficava
  // ocupando a lista dele junto com a tarefa de hoje.
  semContagemFechada?: boolean;
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
    cicloId: item.cicloId ?? null,
    quantidadeEsperada: item.quantidadeEsperada,
    quantidadeTotal: item.quantidadeTotal ?? null,
    quantidadeReservada: item.quantidadeReservada ?? 0,
    dataSaldo: item.dataSaldo?.toISOString(),
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
    tarefaId: item.tarefaId ?? null,
    tarefaNome: item.tarefaNome ?? null,
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
// Descoberta de prédios (a partir do saldo real do Sankhya)
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

// Agrupa por rua/prédio os locais que têm saldo AGORA (TGFEST, relido a cada
// 5 min) — é essa lista que o admin navega pra escolher o que atribuir.
// Prateleira sem saldo não entra: não há o que contar nela. Locais sem rua/prédio
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
  const todosOsLocais = await getLocaisComSaldo(empresa);
  const locais = todosOsLocais.filter(
    (l) => ehLocalDeLoja(l.localCodigo) && localVisivelPara(l.localCodigo, filial)
  );
  const grupos = new Map<string, PredioDisponivel>();

  for (const local of locais) {
    const { rua, predio, nivel } = resolverLocalizacao(
      local.local,
      { codigo: local.localPaiCodigo, descricao: local.localPai },
      ehLocalPaiAgrupador
    );
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
    // Níveis numéricos em ordem numérica; nas áreas (agrupadores) a subdivisão
    // é o nome do local, então cai na ordem alfabética.
    grupo.niveis.sort((a, b) => {
      const na = Number(a.nivel);
      const nb = Number(b.nivel);
      if (a.nivel !== null && b.nivel !== null && Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
      if (a.nivel === null) return 1;
      if (b.nivel === null) return -1;
      return a.nivel.localeCompare(b.nivel, 'pt-BR', { numeric: true });
    });
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

// Atribuir é criar (ou continuar) uma TAREFA. Repetir o mesmo nome numa
// contagem aberta não cria outra: os itens novos entram na tarefa que já
// existe, com o saldo do dia da adição — foi o que a operação combinou, pra
// não picar o mesmo trabalho em vários lotes.
//
// Quando a tarefa já existe (o gestor criou primeiro, escolheu quem vai
// contar e só então escolheu o escopo), `tarefaExistenteId` manda: não se
// procura por nome nem se cria outra.
async function acharOuCriarTarefa(
  nome: string,
  cicloId: string,
  criadaPorId: string,
  responsaveisIds: string[],
  tarefaExistenteId?: string
): Promise<string> {
  const existenteId = await acharTarefaAlvo(nome, cicloId, tarefaExistenteId);

  const tarefaId =
    existenteId ??
    (
      await prisma.tarefa.create({
        data: { nome, tipo: 'CONTAGEM', cicloId, criadaPorId },
      })
    ).id;

  for (const usuarioId of [...new Set(responsaveisIds)]) {
    await prisma.tarefaResponsavel
      .upsert({
        where: { tarefaId_usuarioId: { tarefaId, usuarioId } },
        create: { tarefaId, usuarioId },
        update: {},
      })
      .catch(() => undefined);
  }

  return tarefaId;
}

export interface AtribuirContagemPredioInput {
  rua: string | null;
  predio: string | null;
  // Recorte por marca e/ou grupo de produto do Sankhya: atribui só os itens
  // que casam com o filtro que o admin está vendo na tela. Vazio = tudo.
  marcas?: string[];
  grupos?: string[];
  // Recorte por valor: atribui só o que custa a partir de / até tanto, pelo
  // custo total daquele endereço (custo unitário x disponível).
  custoMinimo?: number;
  custoMaximo?: number;
  // Opcional: atribui só um nível do prédio. undefined = prédio inteiro;
  // null = só os locais do prédio que não trazem nível no nome.
  nivel?: string | null;
  filial?: string | null;
  empresaCodigo: string;
  atribuidoParaId: string;
  // Mais gente no mesmo prédio: os itens são REPARTIDOS entre eles, um dono
  // por item. Ninguém conta o mesmo item duas vezes e o ranking continua
  // medindo o trabalho de cada um.
  atribuidoParaIds?: string[];
  atribuidoPorId: string;
  // Rótulo do lote, dado pelo admin ("Rua 2 manhã"). Só serve pra achar a
  // tarefa depois na aba Contagens; vazio cai no nome do prédio.
  tarefaNome?: string;
  // Tarefa já criada pelo gestor; quando vem, manda sobre o nome. É o que
  // permite distribuir vários prédios dentro da MESMA tarefa.
  tarefaId?: string;
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
    throw new Error('Esse prédio não tem saldo em estoque pra contar.');
  }

  // A lista manda quando vem; senão, uma pessoa só (o formato antigo).
  const responsaveis =
    input.atribuidoParaIds && input.atribuidoParaIds.length > 0
      ? [...new Set(input.atribuidoParaIds)]
      : [input.atribuidoParaId];

  for (const responsavel of responsaveis) {
    await exigirFilialCompativel(responsavel, grupo.filial);
  }

  const locaisAlvo =
    input.nivel === undefined ? grupo.locais : grupo.locais.filter((l) => l.nivel === input.nivel);
  if (locaisAlvo.length === 0) {
    throw new Error('Esse nível não tem itens com saldo pra contar.');
  }

  // A subdivisão de cada local já foi resolvida na montagem do grupo (endereço
  // ou, numa área, o nome do local) — relê-la do nome aqui desfaria isso.
  const nivelPorLocal = new Map(grupo.locais.map((l) => [l.localCodigo, l.nivel]));

  const itensComSaldo = await getItensComSaldoPorLocais(
    locaisAlvo.map((l) => l.localCodigo),
    input.empresaCodigo
  );

  let filtrados = filtrarPorMarcaEGrupo(itensComSaldo, input.marcas, input.grupos);

  if (input.custoMinimo !== undefined || input.custoMaximo !== undefined) {
    const custos = await getCustosSemIcms(
      filtrados.map((i) => ({ codigoProduto: i.codigoProduto, empresaCodigo: i.empresaCodigo }))
    );
    filtrados = filtrados.filter((i) => {
      const unitario = custos.get(chaveCusto(i.codigoProduto, i.empresaCodigo)) ?? 0;
      // Sem custo cadastrado o item fica de fora do recorte por valor: custo
      // zero não é o mesmo que "barato", e incluí-lo encheria a atribuição de
      // item que ninguém pediu.
      if (unitario === 0) return false;
      const total = unitario * i.quantidadeDisponivel;
      if (input.custoMinimo !== undefined && total < input.custoMinimo) return false;
      if (input.custoMaximo !== undefined && total > input.custoMaximo) return false;
      return true;
    });
  }

  if (filtrados.length === 0) {
    throw new Error('Nenhum item com saldo bate com esse filtro.');
  }

  const ciclo = await garantirCicloAberto(input.atribuidoPorId);
  const rotuloTarefa =
    input.tarefaNome?.trim() ||
    rotuloDoGrupo(input.rua, input.predio) +
      (input.nivel !== undefined ? ` · ${rotuloDaSubdivisao(input.nivel)}` : '');

  // A tarefa de destino é resolvida antes: a duplicata que importa é a de
  // dentro dela.
  const alvo = await acharTarefaAlvo(rotuloTarefa, ciclo.id, input.tarefaId);
  const novos = await foraDestaTarefa(filtrados, input.empresaCodigo, alvo);

  if (novos.length === 0) {
    return { criados: 0 };
  }

  const tarefaId = await acharOuCriarTarefa(
    rotuloTarefa,
    ciclo.id,
    input.atribuidoPorId,
    responsaveis,
    input.tarefaId
  );

  await prisma.contagemItem.createMany({
    data: novos.map((i, indice) => ({
      cicloId: ciclo.id,
      tarefaId,
      empresaCodigo: i.empresaCodigo,
      empresaNome: i.empresaNome,
        codigoProduto: i.codigoProduto,
        descricao: i.descricao,
        unidade: i.unidade,
        local: i.local,
        localCodigo: i.localCodigo,
      quantidadeEsperada: i.quantidadeDisponivel,
        quantidadeTotal: i.quantidadeTotal,
        quantidadeReservada: i.quantidadeReservada,
      dataSaldo: new Date(),
      status: 'PENDENTE',
      rua: input.rua,
      predio: input.predio,
        nivel: nivelPorLocal.get(i.localCodigo) ?? null,
      // Reparte em rodízio: com 3 pessoas, o item 1 vai pra primeira, o 2 pra
      // segunda, o 3 pra terceira, o 4 volta pra primeira. Como a lista vem
      // ordenada por local, cada um fica com endereços intercalados em vez de
      // uma pessoa herdar só o fundo do prédio.
      atribuidoParaId: responsaveis[indice % responsaveis.length],
      atribuidoPorId: input.atribuidoPorId,
      tarefaNome: rotuloTarefa,
    })),
  });

  const nomeAdmin = await nomeUsuario(input.atribuidoPorId);
  const rotulo =
    rotuloDoGrupo(input.rua, input.predio) +
    (input.nivel !== undefined ? ` · ${rotuloDaSubdivisao(input.nivel)}` : '');

  for (const [posicao, responsavel] of responsaveis.entries()) {
    // Quantos couberam a esta pessoa, não o total: dizer "40 itens" pra quem
    // recebeu 14 faz a pessoa procurar trabalho que é de outro.
    const meus = novos.filter((_, indice) => indice % responsaveis.length === posicao).length;
    if (meus === 0) continue;
    await notificarUsuario(
      'ATRIBUICAO_CONTAGEM',
      `${input.empresaCodigo}|${chavePredio(input.rua, input.predio)}`,
      'Nova contagem atribuída',
      `${nomeAdmin} atribuiu ${rotulo} pra você contar (${meus} ite${meus === 1 ? 'm' : 'ns'}` +
        (responsaveis.length > 1 ? `, dividido com mais ${responsaveis.length - 1}).` : ').'),
      responsavel
    );
  }

  return { criados: novos.length };
}

export interface TarefaContagem {
  chave: string;
  nome: string;
  // Vazio quando o admin não deu nome: a tela mostra o prédio no lugar.
  nomeado: boolean;
  locais: string;
  responsaveis: { usuarioId: string; nome: string; itens: number }[];
  total: number;
  contados: number;
  divergentes: number;
  atribuidoEm: string;
}

// As tarefas de um inventário, do jeito que o admin as criou: um lote por
// atribuição, com o nome que ele deu. Sem isso a aba Contagens só mostrava
// números do inventário inteiro, e dois lotes do mesmo prédio — o da manhã e
// o da tarde, de pessoas diferentes — eram indistinguíveis.
export async function getTarefasDaContagem(cicloId?: string): Promise<TarefaContagem[]> {
  const itens = await prisma.contagemItem.findMany({
    where: { ...(cicloId ? { cicloId } : {}) },
    select: {
      tarefaNome: true,
      rua: true,
      predio: true,
      status: true,
      atribuidoParaId: true,
      atribuidoEm: true,
      empresaCodigo: true,
    },
  });

  const grupos = new Map<
    string,
    TarefaContagem & { porUsuario: Map<string, number> }
  >();

  for (const item of itens) {
    const nomeado = Boolean(item.tarefaNome);
    // Lote nomeado é um só, venha de quantos prédios vier. Sem nome, o
    // agrupamento cai no prédio, que é o que existia antes.
    const chave = nomeado
      ? `nome:${item.tarefaNome}`
      : `predio:${item.empresaCodigo}|${chavePredio(item.rua, item.predio)}`;

    let grupo = grupos.get(chave);
    if (!grupo) {
      grupo = {
        chave,
        nome: item.tarefaNome ?? rotuloDoGrupo(item.rua, item.predio),
        nomeado,
        locais: rotuloDoGrupo(item.rua, item.predio),
        responsaveis: [],
        total: 0,
        contados: 0,
        divergentes: 0,
        atribuidoEm: item.atribuidoEm.toISOString(),
        porUsuario: new Map(),
      };
      grupos.set(chave, grupo);
    }

    grupo.total += 1;
    if (!STATUS_ABERTOS.includes(item.status as StatusContagemItem)) grupo.contados += 1;
    if (item.status === 'DIVERGENCIA' || item.status === 'DIVERGENCIA_LOCAL') grupo.divergentes += 1;
    if (item.atribuidoParaId) {
      grupo.porUsuario.set(item.atribuidoParaId, (grupo.porUsuario.get(item.atribuidoParaId) ?? 0) + 1);
    }
    // O lote vale pela atribuição mais antiga: é quando ele foi criado.
    if (item.atribuidoEm.toISOString() < grupo.atribuidoEm) {
      grupo.atribuidoEm = item.atribuidoEm.toISOString();
    }
    // Um lote nomeado pode pegar mais de um prédio; o rótulo então vira o
    // número de endereços em vez de mentir dizendo um só.
    const rotulo = rotuloDoGrupo(item.rua, item.predio);
    if (grupo.locais !== rotulo && !grupo.locais.includes('endereços')) {
      grupo.locais = 'Vários endereços';
    }
  }

  const ids = new Set<string>();
  grupos.forEach((g) => g.porUsuario.forEach((_, id) => ids.add(id)));
  const usuarios = await prisma.usuario.findMany({ where: { id: { in: Array.from(ids) } } });
  const nomePorId = new Map(usuarios.map((u) => [u.id, u.nome]));

  return Array.from(grupos.values())
    .map(({ porUsuario, ...tarefa }) => ({
      ...tarefa,
      responsaveis: Array.from(porUsuario.entries())
        .map(([usuarioId, itens]) => ({ usuarioId, nome: nomePorId.get(usuarioId) ?? 'Alguém', itens }))
        .sort((a, b) => b.itens - a.itens),
    }))
    .sort((a, b) => b.atribuidoEm.localeCompare(a.atribuidoEm));
}

// ---------------------------------------------------------------------------
// Gestão da atribuição (repassar pra outro operador / remover)
// ---------------------------------------------------------------------------

// Itens que ainda não produziram nenhum número contado — os únicos que podem
// ser repassados ou removidos sem jogar trabalho fora. Um item já conferido
// (ou em 2ª contagem) fica onde está, com quem contou.
const STATUS_SEM_CONTAGEM: StatusContagemItem[] = ['PENDENTE', 'EM_ANDAMENTO'];

// Recorte por marca/grupo: listas vazias (ou ausentes) não filtram nada.
function filtrarPorMarcaEGrupo<T extends { marca: string | null; grupoCodigo: string | null }>(
  itens: T[],
  marcas?: string[],
  grupos?: string[]
): T[] {
  const porMarca = marcas && marcas.length > 0 ? new Set(marcas) : null;
  const porGrupo = grupos && grupos.length > 0 ? new Set(grupos) : null;
  if (!porMarca && !porGrupo) return itens;

  return itens.filter(
    (item) =>
      (!porMarca || (item.marca !== null && porMarca.has(item.marca))) &&
      (!porGrupo || (item.grupoCodigo !== null && porGrupo.has(item.grupoCodigo)))
  );
}

// Atribuir é idempotente DENTRO DA TAREFA: o mesmo produto+local não entra
// duas vezes na mesma tarefa, senão a pessoa veria o item repetido na lista.
//
// Entre tarefas diferentes, entra. A trava antiga valia pro galpão inteiro —
// produto+local aberto em qualquer contagem não entrava em mais nenhuma — e
// era ela que respondia "esses itens já estão em alguma contagem aberta" e
// deixava as linhas apagadas na tela de atribuir.
//
// Isso contradizia o modelo: tarefa é justamente o recorte que separa
// trabalhos distintos sobre o mesmo item, e desde que a tarefa entrou na chave
// do resultado um não sobrescreve o outro. Uma tarefa esquecida em aberto não
// pode sequestrar o endereço para sempre.
async function foraDestaTarefa<T extends { codigoProduto: string; localCodigo: string }>(
  itens: T[],
  empresaCodigo: string,
  tarefaId: string | null
): Promise<T[]> {
  if (!tarefaId) return itens;

  const existentes = await prisma.contagemItem.findMany({
    where: { empresaCodigo, tarefaId, status: { in: STATUS_ABERTOS } },
    select: { codigoProduto: true, localCodigo: true },
  });
  const abertos = new Set(existentes.map((e) => `${e.codigoProduto}|${e.localCodigo}`));
  return itens.filter((i) => !abertos.has(`${i.codigoProduto}|${i.localCodigo}`));
}

// Qual tarefa vai receber os itens, sem criá-la: é preciso saber disso ANTES
// de filtrar duplicata, e criar aqui deixaria tarefa vazia para trás quando
// nada entra.
async function acharTarefaAlvo(
  nome: string,
  cicloId: string,
  tarefaExistenteId?: string
): Promise<string | null> {
  if (tarefaExistenteId) {
    const existente = await prisma.tarefa.findUnique({ where: { id: tarefaExistenteId } });
    if (!existente) throw new Error('Essa tarefa não existe mais.');
    return existente.id;
  }
  const porNome = await prisma.tarefa.findFirst({
    where: { nome, tipo: 'CONTAGEM', cicloId, status: 'ABERTA' },
  });
  return porNome?.id ?? null;
}

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
  return rotuloDoGrupo(rua, predio);
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
// igualzinho a partir do saldo do Sankhya numa próxima atribuição). O que já
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

export interface ProdutoDoBipe extends ProdutoBuscaSankhya {
  // Como o produto foi identificado — a tela usa isso pra decidir se pode
  // seguir sozinha ou se precisa perguntar.
  origem: 'CODIGO_INTERNO' | 'BIPE_ANTERIOR';
}

export interface RespostaDoBipe {
  produtos: ProdutoDoBipe[];
  // O código lido é etiqueta de prateleira, não de produto.
  ehEtiquetaDeLocal: boolean;
}

// Descobre QUAL produto é o código que a câmera leu.
//
// Medido na produção: em 400 bipes gravados, só 25 (6%) eram o CODPROD do
// Sankhya. Nos outros 94% a etiqueta é o EAN do fabricante, que o ERP não tem
// cadastrado (TGFPRO.CODBARRA não existe aqui) — não há tabela que traduza.
//
// O que existe é histórico: cada contagem já feita gravou o código lido ao
// lado do produto que a pessoa confirmou estar contando. São 558 códigos
// distintos, e só 11 deles (2%) apontam pra mais de um produto. Isso é um
// dicionário — e ele cresce sozinho a cada item contado.
//
// Quando o código continua desconhecido, quem responde é a pessoa: a tela cai
// na lista do prédio. Ela escolhe, e o par fica aprendido pro próximo bipe.
export async function resolverProdutoDoBipe(codigo: string): Promise<RespostaDoBipe> {
  const lido = codigo.trim();
  if (!lido) return { produtos: [], ehEtiquetaDeLocal: false };

  // Etiqueta de prateleira bipada no campo do produto acontece — dois casos
  // já estão gravados. Como a tela agora segue sozinha quando o código
  // resolve, um par desses mandaria a pessoa contar o item errado sem
  // perguntar. Aqui o código é devolvido como o que ele é.
  const ehLocal = await prisma.contagemItem.findFirst({
    where: { localCodigo: lido },
    select: { id: true },
  });
  if (ehLocal) return { produtos: [], ehEtiquetaDeLocal: true };

  const [porContagem, porConferencia] = await Promise.all([
    prisma.contagemItem.findMany({
      where: {
        // Só ensina o par quem terminou de contar: bipe abandonado no meio
        // não confirma que aquele código era daquele produto.
        OR: [
          { codigoProdutoBipado: lido, quantidadeConferida: { not: null } },
          { codigoProdutoBipado2: lido, quantidadeConferida2: { not: null } },
        ],
      },
      select: { codigoProduto: true, descricao: true, unidade: true },
      distinct: ['codigoProduto'],
      take: 20,
    }),
    prisma.itemConferenciaResultado.findMany({
      where: { codigoProdutoBipado: lido },
      select: { codigoProduto: true, descricao: true },
      distinct: ['codigoProduto'],
      take: 20,
    }),
  ]);

  const porCodigo = new Map<string, ProdutoDoBipe>();
  for (const i of porContagem) {
    porCodigo.set(i.codigoProduto, {
      codigoProduto: i.codigoProduto,
      descricao: i.descricao,
      unidade: i.unidade,
      origem: 'BIPE_ANTERIOR',
    });
  }
  for (const i of porConferencia) {
    if (porCodigo.has(i.codigoProduto)) continue;
    porCodigo.set(i.codigoProduto, {
      codigoProduto: i.codigoProduto,
      descricao: i.descricao,
      unidade: '',
      origem: 'BIPE_ANTERIOR',
    });
  }

  // O código de barras cadastrado no ERP (TGFBAR). É a única fonte que não é
  // palpite: alguém cadastrou aquele código naquele produto. Hoje só 183
  // produtos têm — cadastrar mais é o que faria o bipe resolver de primeira,
  // sem depender do histórico.
  const porBarra = await getProdutoPorCodigoBarras(lido);
  if (porBarra.length > 0) {
    for (const p of porBarra) porCodigo.delete(p.codigoProduto);
    return {
      produtos: [
        ...porBarra.map((p) => ({ ...p, origem: 'CODIGO_INTERNO' as const })),
        ...porCodigo.values(),
      ],
      ehEtiquetaDeLocal: false,
    };
  }

  // O código lido pode ser o próprio CODPROD (etiqueta interna do galpão).
  // Esse caminho também é certeza, então vem antes do histórico.
  if (/^[0-9]+$/.test(lido)) {
    const doSankhya = await buscarProdutosSankhya(lido);
    const exato = doSankhya.find((p) => p.codigoProduto === lido);
    if (exato) {
      porCodigo.delete(exato.codigoProduto);
      return {
        produtos: [{ ...exato, origem: 'CODIGO_INTERNO' }, ...porCodigo.values()],
        ehEtiquetaDeLocal: false,
      };
    }
  }

  return { produtos: [...porCodigo.values()], ehEtiquetaDeLocal: false };
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

  // Sem exigir saldo no local bipado: o item fora do lugar é, por definição,
  // o produto que o Sankhya NÃO tem naquele endereço.
  const base = await getItemForaDoLugar(input.codigoProduto, input.codigoLocalBipado);
  if (!base) {
    throw new Error('Não achei esse produto no Sankhya. Confira o código do produto.');
  }
  if (ehLocalDeQuarentena(base.local)) {
    throw new Error(`${base.local} é área de quarentena — produto em quarentena não entra na contagem.`);
  }
  await conferirBipeDoProduto(base, input.codigoProdutoBipado);

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
    base.quantidadeDisponivel > 0 || locaisEsperados.some((l) => l.localCodigo === base.localCodigo);
  const outrosLocais = locaisEsperados.filter((l) => l.localCodigo !== base.localCodigo);
  const divergenciaLocal = !esperadoAqui;
  const localEsperado = outrosLocais.length > 0 ? outrosLocais.map((l) => l.local).join(' | ') : null;

  const { rua, predio, nivel } = resolverLocalizacao(
    base.local,
    await getPaiDoLocal(base.localCodigo),
    ehLocalPaiAgrupador
  );

  const cicloDoItem = await garantirCicloAberto(input.usuarioId);
  const tarefaDoAchado = await acharOuCriarTarefa(
    `Itens fora do lugar · ${new Date().toLocaleDateString('pt-BR')}`,
    cicloDoItem.id,
    input.usuarioId,
    [input.usuarioId]
  );

  const criado = await prisma.contagemItem.create({
    data: {
      cicloId: cicloDoItem.id,
      tarefaId: tarefaDoAchado,
      empresaCodigo: base.empresaCodigo,
      empresaNome: base.empresaNome,
      codigoProduto: base.codigoProduto,
      descricao: base.descricao,
      unidade: base.unidade,
      local: base.local,
      localCodigo: base.localCodigo,
      quantidadeEsperada: base.quantidadeDisponivel,
      quantidadeTotal: base.quantidadeTotal,
      quantidadeReservada: base.quantidadeReservada,
      dataSaldo: new Date(),
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
      // Vazio vira null: item sem código de barras não deve poluir o
      // dicionário de bipes nem os relatórios com string vazia.
      codigoProdutoBipado: input.codigoProdutoBipado || null,
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
//
// A etiqueta é do NÍVEL, e é ela que vale. Não existe etiqueta de prédio:
// medido na produção, nível e local são 1:1 (186 níveis, 186 códigos, nenhuma
// ambiguidade nos dois sentidos). Quem conta está de pé num nível, e é o
// código daquele nível que ele tem diante dos olhos.
//
// Um bipe por nível continua cobrindo todos os itens dele — que é o que
// evitava bipar 46 vezes o mesmo código num prédio de 46 itens (média real:
// 8,5 itens por nível).
//
// Aceitar a etiqueta de um nível VIZINHO, como esta função já fez, custou
// caro: a tela olhava o endereçamento inteiro e liberava, e aqui a busca
// exigia que o código bipado tivesse item no mesmo ciclo — 49 dos 906 itens
// abertos passavam na tela e falhavam na hora de contar. Dois validadores com
// regras diferentes é sempre assim; agora só existe uma regra.
// Onde fica, fisicamente, o código de uma etiqueta. O endereçamento é estável:
// nenhum localCodigo aparece em dois prédios diferentes.
async function ondeFicaEtiqueta(codigo: string, empresaCodigo: string) {
  return prisma.contagemItem.findFirst({
    where: { localCodigo: codigo.trim(), empresaCodigo },
    select: { local: true, rua: true, predio: true, nivel: true },
  });
}

// A etiqueta bipada é deste NÍVEL?
//
// Não dá pra exigir o código exato do item. A Rua 4 é gaveteira: "Rua 4 ·
// Prédio 1 · Nível 1" tem 187 gavetas, cada uma com a sua etiqueta e cerca de
// um item. Exigir o código exato traria de volta um bipe por item — que é
// justamente o que o bipe por nível eliminou.
//
// Quando eu escrevi a regra, nível e etiqueta eram 1:1 (186 para 186). A Rua 4
// entrou depois e quebrou a premissa: hoje são 1.694 locais para 507 níveis,
// e 1.196 dos locais são gaveta.
//
// A regra certa é a do galpão: vale qualquer etiqueta do mesmo nível. Etiqueta
// de outro nível, de outro prédio ou de outra rua continua recusada.
async function conferirBipeDoLocal(
  item: { localCodigo: string; local: string; empresaCodigo: string; rua: string | null; predio: string | null; nivel: string | null },
  codigoLocalBipado: string
): Promise<void> {
  const lido = codigoLocalBipado.trim();
  if (lido === item.localCodigo) return;

  const onde = await ondeFicaEtiqueta(lido, item.empresaCodigo);
  if (onde && onde.rua === item.rua && onde.predio === item.predio && onde.nivel === item.nivel) {
    return;
  }

  throw new Error(
    onde
      ? `Essa etiqueta é de ${onde.local}, e o item está em ${item.local}.`
      : `Não reconheci a etiqueta ${lido}. Bipe uma etiqueta de ${item.local}.`
  );
}

// O código bipado identifica mesmo este produto?
//
// Três fontes valem, da mais confiável pra menos: o próprio CODPROD, o código
// de barras cadastrado no ERP (TGFBAR) e o histórico de bipes já confirmados.
// A terceira é indispensável: o Sankhya tem código cadastrado pra 183
// produtos, e é pelo histórico que os outros resolvem — conferir só contra
// CODPROD e TGFBAR recusaria o bipe que o próprio app acabou de aceitar.
export async function bipeIdentificaProduto(
  codigoBipado: string,
  codigoProduto: string
): Promise<boolean> {
  if (await codigoBipadoIdentificaProduto(codigoBipado, codigoProduto)) return true;

  const { produtos } = await resolverProdutoDoBipe(codigoBipado);
  return produtos.some((p) => p.codigoProduto === codigoProduto.trim());
}

async function conferirBipeDoProduto(
  item: { codigoProduto: string; descricao: string },
  codigoProdutoBipado: string
): Promise<void> {
  // Sem código lido não há o que conferir. Metade do estoque não tem código de
  // barras nenhum — conexão de ferro fundido solta não carrega etiqueta —, e
  // exigir o bipe aqui travaria justamente esses itens.
  if (!codigoProdutoBipado.trim()) return;

  if (await bipeIdentificaProduto(codigoProdutoBipado, item.codigoProduto)) return;

  throw new Error(
    `O código bipado não pertence a ${item.descricao}. Bipe o código desse produto, ou conte pela lista se ele não tiver código de barras.`
  );
}

export type ConferenciaEtiqueta =
  | { resultado: 'DESTE_NIVEL'; local: string }
  | { resultado: 'OUTRO_LUGAR'; local: string; onde: string }
  | { resultado: 'DESCONHECIDA' };

// Responde, na hora do bipe, se a etiqueta lida é mesmo do nível aberto.
//
// A validação de verdade vive em conferirBipeDoLocal, mas só roda quando o
// item vai ser contado. Sem perguntar aqui, o colaborador bipava a etiqueta
// errada, via "Nível bipado ✓" e só descobria o erro itens depois — ou nunca.
//
// O app não consegue decidir isso sozinho, e a Rua 4 mostra por quê: um nível
// lá tem 187 gavetas, repartidas entre duas pessoas. Quem abre o nível só
// carrega os itens DELE, então metade das etiquetas do próprio nível é
// desconhecida para o app. Só o servidor enxerga o endereçamento inteiro.
//
// Responde exatamente o que conferirBipeDoLocal vai decidir depois: uma regra
// só, pra tela nunca liberar o que a contagem vai recusar.
export async function conferirEtiquetaDoPredio(input: {
  empresaCodigo: string;
  rua: string | null;
  predio: string | null;
  nivel?: string | null;
  codigo: string;
}): Promise<ConferenciaEtiqueta> {
  const local = await ondeFicaEtiqueta(input.codigo, input.empresaCodigo);

  // Local que nunca entrou numa contagem: não dá pra afirmar que está errado.
  if (!local) return { resultado: 'DESCONHECIDA' };

  const mesmoPredio = local.rua === input.rua && local.predio === input.predio;
  // `nivel` ausente = pergunta antiga, do tempo em que o bipe valia pro prédio
  // inteiro. Aceita pelo prédio pra não quebrar APK já instalado.
  const mesmoNivel = input.nivel === undefined || local.nivel === input.nivel;

  if (mesmoPredio && mesmoNivel) {
    return { resultado: 'DESTE_NIVEL', local: local.local };
  }

  return {
    resultado: 'OUTRO_LUGAR',
    local: local.local,
    onde: rotuloDoGrupo(local.rua, local.predio) +
      (local.nivel ? ` · ${rotuloDaSubdivisao(local.nivel)}` : ''),
  };
}

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
  await conferirBipeDoProduto(item, input.codigoProdutoBipado);
  await conferirBipeDoLocal(item, input.codigoLocalBipado);

  const atualizado = await prisma.contagemItem.update({
    where: { id: item.id },
    data: {
      status: 'EM_ANDAMENTO',
      iniciadoPorId: input.usuarioId,
      iniciadoEm: new Date(),
      // Vazio vira null: item sem código de barras não deve poluir o
      // dicionário de bipes nem os relatórios com string vazia.
      codigoProdutoBipado: input.codigoProdutoBipado || null,
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
  await conferirBipeDoProduto(item, codigoProdutoBipado);
  await conferirBipeDoLocal(item, codigoLocalBipado);

  const atualizado = await prisma.contagemItem.update({
    where: { id: itemId },
    data: {
      status: 'SEGUNDA_EM_ANDAMENTO',
      segundaContagemIniciadaEm: new Date(),
      codigoProdutoBipado2: codigoProdutoBipado || null,
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
      ...(filtro?.cicloId ? { cicloId: filtro.cicloId } : {}),
      ...(filtro?.tarefaIds && filtro.tarefaIds.length > 0
        ? { tarefaId: { in: filtro.tarefaIds } }
        : {}),
      // Item sem ciclo é de antes do conceito existir; continua aparecendo,
      // porque não há inventário fechado pra ele.
      ...(filtro?.semContagemFechada
        ? { OR: [{ cicloId: null }, { ciclo: { status: { not: 'FECHADO' } } }] }
        : {}),
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

  // Reservado na prateleira ou já separado? Depende de a separação ter
  // acontecido, e o sistema não sabe disso. Medindo as contagens reais: de 36
  // itens com reserva, 23 bateram com o disponível (o reservado tinha saído) e
  // 7 com o total (ainda estava lá). Nenhuma das duas regras sozinha está
  // certa, então as duas contam como acerto — o contrário é acusar quem contou
  // corretamente uma prateleira que ainda não foi separada.
  //
  // O preço é não detectar um erro que seja exatamente do tamanho da reserva.
  // Acusar gente certa custa mais: é o que faz o time parar de confiar no
  // número e conferir tudo de novo por fora.
  const bateuDisponivel = input.quantidadeConferida === item.quantidadeEsperada;
  const bateuTotal =
    item.quantidadeTotal !== null && input.quantidadeConferida === item.quantidadeTotal;
  const diferenca =
    bateuDisponivel || bateuTotal ? 0 : input.quantidadeConferida - item.quantidadeEsperada;
  // O motivo NÃO é mais cobrado de quem conta.
  //
  // Cobrá-lo obrigava o app a dizer "essa contagem não bateu com o sistema" —
  // ou seja, entregava o esperado a quem deveria contar às cegas, e ainda
  // permitia ir tentando número até a mensagem sumir. Quem classifica o
  // motivo é o gestor, no painel, olhando a divergência.
  const motivo = item.divergenciaLocal
    ? (input.motivo ?? 'Item encontrado em local diferente do sistema')
    : input.motivo;

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
      `${nome} contou ${item.descricao} (${item.local})${rotulo}: bateu com o estoque disponível.`
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

export async function getIndicadoresContagem(
  filial?: string | null,
  cicloId?: string
): Promise<IndicadoresContagemDTO> {
  const grupos = await prisma.contagemItem.groupBy({
    by: ['status'],
    _count: { _all: true },
    where: {
      ...(ehFilial(filial) ? { localCodigo: { startsWith: prefixoDaFilial(filial) } } : {}),
      ...(cicloId ? { cicloId } : {}),
    },
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

export async function getProgressoContagemPorPredio(
  filial?: string | null,
  cicloId?: string
): Promise<ProgressoPredio[]> {
  const itens = await prisma.contagemItem.findMany({
    where: {
      ...(ehFilial(filial) ? { localCodigo: { startsWith: prefixoDaFilial(filial) } } : {}),
      ...(cicloId ? { cicloId } : {}),
    },
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

// ---------------------------------------------------------------------------
// Reservas: quais pedidos prendem o item
// ---------------------------------------------------------------------------

export interface ReservaDoItemDTO {
  quantidadeReservada: number;
  pedidos: PedidoQueReserva[];
}

// O monitoramento mostra a quantidade reservada ao lado da contada; aqui o
// admin abre o detalhe e vê de ONDE vem essa reserva. O total é recalculado
// pela soma dos pedidos, não pelo valor gravado na atribuição: a reserva pode
// ter mudado desde então, e o que importa nessa tela é o agora.
export async function getReservaDoItem(itemId: string): Promise<ReservaDoItemDTO | null> {
  const item = await prisma.contagemItem.findUnique({ where: { id: itemId } });
  if (!item) return null;

  const pedidos = await getPedidosQueReservam(item.codigoProduto, item.localCodigo, item.empresaCodigo);
  return {
    quantidadeReservada: pedidos.reduce((total, pedido) => total + pedido.quantidade, 0),
    pedidos,
  };
}

// ---------------------------------------------------------------------------
// Atribuição item a item (e o catálogo de marcas/grupos pra filtrar)
// ---------------------------------------------------------------------------

export interface ItemDisponivelDTO {
  codigoProduto: string;
  descricao: string;
  unidade: string;
  localCodigo: string;
  local: string;
  nivel: string | null;
  marca: string | null;
  grupoCodigo: string | null;
  grupo: string | null;
  // Onde o item está. Preenchidos na busca por filtro, em que a lista mistura
  // prédios; na listagem de um prédio só, vêm nulos porque já se sabe qual é.
  rua?: string | null;
  predio?: string | null;
  empresaCodigo?: string;
  empresaNome?: string;
  quantidadeTotal: number;
  quantidadeReservada: number;
  quantidadeDisponivel: number;
  // Custo sem ICMS do Sankhya, por unidade. Zero quando o produto não tem
  // custo cadastrado — o que é diferente de custar zero, e por isso o filtro
  // por valor ignora esses itens em vez de tratá-los como baratos.
  custoUnitario: number;
  // custoUnitario x disponível: é por este número que o admin prioriza,
  // porque é o dinheiro parado naquele endereço.
  custoTotal: number;
  // Já está numa contagem aberta — atribuir de novo não faria nada.
  emContagem: boolean;
}

export interface ItensDisponiveisDTO {
  itens: ItemDisponivelDTO[];
  // O que existe de fato NESSE prédio, pra montar os filtros da tela sem
  // oferecer marca/grupo que não tem item aqui.
  marcas: string[];
  grupos: { codigo: string; nome: string }[];
}

// Os itens de um prédio (ou de um nível dele), um a um — é o que a tela de
// atribuições do painel lista pra o admin escolher o que mandar contar.
export async function getItensDisponiveis(filtro: {
  empresaCodigo: string;
  rua: string | null;
  predio: string | null;
  nivel?: string | null;
}): Promise<ItensDisponiveisDTO> {
  const predios = await getPrediosDisponiveis(filtro.empresaCodigo);
  const grupo = predios.find((p) => p.rua === filtro.rua && p.predio === filtro.predio);
  if (!grupo) return { itens: [], marcas: [], grupos: [] };

  const locaisAlvo =
    filtro.nivel === undefined ? grupo.locais : grupo.locais.filter((l) => l.nivel === filtro.nivel);
  const nivelPorLocal = new Map(grupo.locais.map((l) => [l.localCodigo, l.nivel]));

  const comSaldo = await getItensComSaldoPorLocais(
    locaisAlvo.map((l) => l.localCodigo),
    filtro.empresaCodigo
  );

  const [abertos, custos] = await Promise.all([
    prisma.contagemItem.findMany({
      where: { empresaCodigo: filtro.empresaCodigo, status: { in: STATUS_ABERTOS } },
      select: { codigoProduto: true, localCodigo: true },
    }),
    getCustosSemIcms(
      comSaldo.map((i) => ({ codigoProduto: i.codigoProduto, empresaCodigo: i.empresaCodigo }))
    ),
  ]);
  const chavesAbertas = new Set(abertos.map((a) => `${a.codigoProduto}|${a.localCodigo}`));

  const itens: ItemDisponivelDTO[] = comSaldo.map((i) => {
    const custoUnitario = custos.get(chaveCusto(i.codigoProduto, i.empresaCodigo)) ?? 0;
    return {
      codigoProduto: i.codigoProduto,
      descricao: i.descricao,
      unidade: i.unidade,
      localCodigo: i.localCodigo,
      local: i.local,
      nivel: nivelPorLocal.get(i.localCodigo) ?? null,
      marca: i.marca,
      grupoCodigo: i.grupoCodigo,
      grupo: i.grupo,
      quantidadeTotal: i.quantidadeTotal,
      quantidadeReservada: i.quantidadeReservada,
      quantidadeDisponivel: i.quantidadeDisponivel,
      custoUnitario,
      custoTotal: Math.round(custoUnitario * i.quantidadeDisponivel * 100) / 100,
      emContagem: chavesAbertas.has(`${i.codigoProduto}|${i.localCodigo}`),
    };
  });

  const marcas = [...new Set(itens.map((i) => i.marca).filter((m): m is string => !!m))].sort(
    (a, b) => a.localeCompare(b, 'pt-BR')
  );
  const gruposMapa = new Map<string, string>();
  for (const item of itens) {
    if (item.grupoCodigo) gruposMapa.set(item.grupoCodigo, item.grupo ?? item.grupoCodigo);
  }
  const grupos = [...gruposMapa.entries()]
    .map(([codigo, nome]) => ({ codigo, nome }))
    .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));

  return { itens, marcas, grupos };
}

export interface BuscaItensInput {
  empresaCodigo?: string;
  filial?: string | null;
  marcas?: string[];
  grupos?: string[];
  custoMinimo?: number;
  custoMaximo?: number;
  busca?: string;
  // Teto do que volta pra tela. O estoque inteiro passa de 10 mil itens, e
  // jogar isso numa tabela é o que trava o navegador de quem está
  // apresentando. O total real vem em `totalEncontrado`.
  limite?: number;
}

export interface BuscaItensResultado {
  itens: ItemDisponivelDTO[];
  marcas: string[];
  grupos: { codigo: string; nome: string }[];
  totalEncontrado: number;
  limitado: boolean;
}

const LIMITE_PADRAO_BUSCA = 400;

// Procurar item para atribuir SEM ter que escolher um prédio antes.
//
// A tela de Atribuições só deixava filtrar marca/grupo/valor depois de abrir
// um prédio, mas quem distribui quer o contrário: achar "tudo da marca X
// acima de R$ 500" onde quer que esteja, e só então mandar para alguém.
export async function buscarItensParaAtribuir(
  input: BuscaItensInput
): Promise<BuscaItensResultado> {
  const predios = await getPrediosDisponiveis(input.empresaCodigo, input.filial ?? undefined);
  if (predios.length === 0) {
    return { itens: [], marcas: [], grupos: [], totalEncontrado: 0, limitado: false };
  }

  const nivelPorLocal = new Map<string, string | null>();
  const predioPorLocal = new Map<string, { rua: string | null; predio: string | null }>();
  const locaisPorEmpresa = new Map<string, string[]>();
  for (const p of predios) {
    for (const l of p.locais) {
      nivelPorLocal.set(l.localCodigo, l.nivel);
      predioPorLocal.set(l.localCodigo, { rua: p.rua, predio: p.predio });
      const lista = locaisPorEmpresa.get(p.empresaCodigo) ?? [];
      lista.push(l.localCodigo);
      locaisPorEmpresa.set(p.empresaCodigo, lista);
    }
  }

  let comSaldo: Awaited<ReturnType<typeof getItensComSaldoPorLocais>> = [];
  for (const [empresa, locais] of locaisPorEmpresa) {
    comSaldo = comSaldo.concat(await getItensComSaldoPorLocais(locais, empresa));
  }

  // As listas de marca e grupo saem do universo TODO, não do recorte: senão,
  // escolher uma marca faria as outras sumirem do filtro.
  const marcas = [...new Set(comSaldo.map((i) => i.marca).filter((m): m is string => !!m))].sort(
    (a, b) => a.localeCompare(b, 'pt-BR')
  );
  const gruposMapa = new Map<string, string>();
  for (const i of comSaldo) {
    if (i.grupoCodigo) gruposMapa.set(i.grupoCodigo, i.grupo ?? i.grupoCodigo);
  }
  const grupos = [...gruposMapa.entries()]
    .map(([codigo, nome]) => ({ codigo, nome }))
    .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));

  let filtrados = filtrarPorMarcaEGrupo(comSaldo, input.marcas, input.grupos);

  const termo = input.busca?.trim().toLowerCase();
  if (termo) {
    filtrados = filtrados.filter((i) =>
      [i.descricao, i.codigoProduto, i.local, i.marca ?? '', i.grupo ?? '']
        .join(' ')
        .toLowerCase()
        .includes(termo)
    );
  }

  const precisaCusto =
    input.custoMinimo !== undefined || input.custoMaximo !== undefined || filtrados.length <= 1500;
  const custos = precisaCusto
    ? await getCustosSemIcms(
        filtrados.map((i) => ({ codigoProduto: i.codigoProduto, empresaCodigo: i.empresaCodigo }))
      )
    : new Map<string, number>();

  if (input.custoMinimo !== undefined || input.custoMaximo !== undefined) {
    filtrados = filtrados.filter((i) => {
      const unitario = custos.get(chaveCusto(i.codigoProduto, i.empresaCodigo)) ?? 0;
      // Sem custo cadastrado o item fica fora do recorte por valor: custo zero
      // não é "barato". Foi o item sem custo que sujou o mapa na reunião.
      if (unitario === 0) return false;
      const total = unitario * i.quantidadeDisponivel;
      if (input.custoMinimo !== undefined && total < input.custoMinimo) return false;
      if (input.custoMaximo !== undefined && total > input.custoMaximo) return false;
      return true;
    });
  }

  const empresasDoRecorte = [...new Set(filtrados.map((i) => i.empresaCodigo))];
  const abertos = await prisma.contagemItem.findMany({
    where: { empresaCodigo: { in: empresasDoRecorte }, status: { in: STATUS_ABERTOS } },
    select: { codigoProduto: true, localCodigo: true },
  });
  const chavesAbertas = new Set(abertos.map((a) => `${a.codigoProduto}|${a.localCodigo}`));

  const totalEncontrado = filtrados.length;
  const limite = input.limite ?? LIMITE_PADRAO_BUSCA;

  // Mais caro primeiro: é o que o gestor quer contar antes, e foi o pedido de
  // ordenar do maior para o menor pra não ter que rolar a lista inteira.
  const ordenados = [...filtrados].sort((a, b) => {
    const ca = (custos.get(chaveCusto(a.codigoProduto, a.empresaCodigo)) ?? 0) * a.quantidadeDisponivel;
    const cb = (custos.get(chaveCusto(b.codigoProduto, b.empresaCodigo)) ?? 0) * b.quantidadeDisponivel;
    return cb - ca || a.descricao.localeCompare(b.descricao, 'pt-BR');
  });

  const itens: ItemDisponivelDTO[] = ordenados.slice(0, limite).map((i) => {
    const custoUnitario = custos.get(chaveCusto(i.codigoProduto, i.empresaCodigo)) ?? 0;
    const doPredio = predioPorLocal.get(i.localCodigo);
    return {
      codigoProduto: i.codigoProduto,
      descricao: i.descricao,
      unidade: i.unidade,
      localCodigo: i.localCodigo,
      local: i.local,
      nivel: nivelPorLocal.get(i.localCodigo) ?? null,
      marca: i.marca,
      grupoCodigo: i.grupoCodigo,
      grupo: i.grupo,
      rua: doPredio?.rua ?? null,
      predio: doPredio?.predio ?? null,
      empresaCodigo: i.empresaCodigo,
      empresaNome: i.empresaNome,
      quantidadeTotal: i.quantidadeTotal,
      quantidadeReservada: i.quantidadeReservada,
      quantidadeDisponivel: i.quantidadeDisponivel,
      custoUnitario,
      custoTotal: Math.round(custoUnitario * i.quantidadeDisponivel * 100) / 100,
      emContagem: chavesAbertas.has(`${i.codigoProduto}|${i.localCodigo}`),
    };
  });

  return { itens, marcas, grupos, totalEncontrado, limitado: totalEncontrado > limite };
}

export interface AtribuirContagemItensInput {
  empresaCodigo: string;
  itens: { codigoProduto: string; localCodigo: string }[];
  atribuidoParaId: string;
  // Mais de uma pessoa no mesmo lote: os itens são repartidos em rodízio,
  // igual à atribuição por prédio. Sem isso, escolher três pessoas mandava
  // tudo pra primeira e as outras duas ficavam com a tarefa vazia.
  atribuidoParaIds?: string[];
  atribuidoPorId: string;
  tarefaNome?: string;
  // Tarefa já criada pelo gestor; quando vem, manda sobre o nome.
  tarefaId?: string;
}

// Atribui uma seleção avulsa de itens, sem precisar mandar o prédio inteiro.
// Rua/prédio/nível de cada um saem do local, do mesmo jeito que na atribuição
// por prédio — o agrupamento da contagem continua valendo.
export async function atribuirContagemItens(
  input: AtribuirContagemItensInput
): Promise<{ criados: number }> {
  if (input.itens.length === 0) throw new Error('Escolha ao menos um item pra atribuir.');

  const locais = [...new Set(input.itens.map((i) => i.localCodigo))];
  const comSaldo = await getItensComSaldoPorLocais(locais, input.empresaCodigo);

  const pedidos = new Set(input.itens.map((i) => `${i.codigoProduto}|${i.localCodigo}`));
  const escolhidos = comSaldo.filter((i) => pedidos.has(`${i.codigoProduto}|${i.localCodigo}`));
  if (escolhidos.length === 0) {
    throw new Error('Nenhum dos itens escolhidos tem saldo em estoque agora.');
  }

  // Ninguém recebe prateleira de outra loja — mesma regra da atribuição por
  // prédio, conferida aqui local a local porque a seleção pode misturar.
  for (const filial of new Set(escolhidos.map((i) => filialDoLocal(i.localCodigo)))) {
    await exigirFilialCompativel(input.atribuidoParaId, filial);
  }

  const ciclo = await garantirCicloAberto(input.atribuidoPorId);
  const rotuloTarefa = input.tarefaNome?.trim() || `Itens avulsos · ${new Date().toLocaleDateString('pt-BR')}`;
  const responsaveis =
    input.atribuidoParaIds && input.atribuidoParaIds.length > 0
      ? [...new Set(input.atribuidoParaIds)]
      : [input.atribuidoParaId];

  // A tarefa de destino é resolvida antes: a duplicata que importa é a de
  // dentro dela.
  const alvo = await acharTarefaAlvo(rotuloTarefa, ciclo.id, input.tarefaId);
  const novos = await foraDestaTarefa(escolhidos, input.empresaCodigo, alvo);
  if (novos.length === 0) return { criados: 0 };

  const paisPorLocal = new Map<string, Awaited<ReturnType<typeof getPaiDoLocal>>>();
  for (const localCodigo of new Set(novos.map((i) => i.localCodigo))) {
    paisPorLocal.set(localCodigo, await getPaiDoLocal(localCodigo));
  }

  const tarefaId = await acharOuCriarTarefa(
    rotuloTarefa,
    ciclo.id,
    input.atribuidoPorId,
    responsaveis,
    input.tarefaId
  );

  await prisma.contagemItem.createMany({
    data: novos.map((i, indice) => {
      const { rua, predio, nivel } = resolverLocalizacao(
        i.local,
        paisPorLocal.get(i.localCodigo) ?? null,
        ehLocalPaiAgrupador
      );
      return {
        cicloId: ciclo.id,
        tarefaId,
        empresaCodigo: i.empresaCodigo,
        empresaNome: i.empresaNome,
          codigoProduto: i.codigoProduto,
          descricao: i.descricao,
          unidade: i.unidade,
          local: i.local,
          localCodigo: i.localCodigo,
        quantidadeEsperada: i.quantidadeDisponivel,
          quantidadeTotal: i.quantidadeTotal,
          quantidadeReservada: i.quantidadeReservada,
        dataSaldo: new Date(),
        status: 'PENDENTE',
        rua,
        predio,
        nivel,
        atribuidoParaId: responsaveis[indice % responsaveis.length],
        atribuidoPorId: input.atribuidoPorId,
        tarefaNome: rotuloTarefa,
      };
    }),
  });

  const nomeAdmin = await nomeUsuario(input.atribuidoPorId);
  for (const [posicao, responsavel] of responsaveis.entries()) {
    // Quantos couberam a ESTA pessoa: dizer o total do lote pra quem recebeu
    // um terço dele faz a pessoa procurar itens que não são dela.
    const quantos = novos.filter((_, indice) => indice % responsaveis.length === posicao).length;
    if (quantos === 0) continue;
    await notificarUsuario(
      'ATRIBUICAO_CONTAGEM',
      `${input.empresaCodigo}|itens`,
      'Nova contagem atribuída',
      `${nomeAdmin} atribuiu ${quantos} ite${quantos === 1 ? 'm' : 'ns'} pra você contar.`,
      responsavel
    );
  }

  return { criados: novos.length };
}

// ---------------------------------------------------------------------------
// Não encontrado: registrar zero sem bipar
// ---------------------------------------------------------------------------

// Exigir o bipe do local pra registrar zero é pedir que a pessoa prove que
// esteve num lugar onde o produto não está. O bipe existe pra garantir que a
// contagem de uma QUANTIDADE veio do endereço certo; quando a quantidade é
// zero não há o que validar, e a exigência só trava a fila.
//
// Fica registrado como zero contado, com motivo automático, e o item segue o
// mesmo caminho de qualquer outra divergência.
export async function registrarNaoEncontrado(
  itemId: string,
  usuarioId: string
): Promise<ContagemItemDTO> {
  const item = await prisma.contagemItem.findUnique({ where: { id: itemId } });
  if (!item) throw new Error('Item não encontrado.');

  const segunda = item.segundaContagemSolicitada && item.quantidadeConferida2 === null;
  const dono = segunda ? item.segundaContagemUsuarioId : item.atribuidoParaId;
  if (dono !== usuarioId) {
    throw new Error('Esse item não está na sua lista de contagem.');
  }
  if (!segunda && item.quantidadeConferida !== null) {
    throw new Error('Esse item já foi contado.');
  }

  // Passa pelo mesmo estado "em andamento" de qualquer contagem, pra a
  // trilha registrar quem e quando. Os campos de bipe ficam vazios de
  // propósito: é a marca de que ninguém escaneou nada aqui.
  await prisma.contagemItem.update({
    where: { id: itemId },
    data: segunda
      ? { status: 'SEGUNDA_EM_ANDAMENTO', segundaContagemIniciadaEm: new Date() }
      : { status: 'EM_ANDAMENTO', iniciadoPorId: usuarioId, iniciadoEm: new Date() },
  });

  return enviarContagemItem({
    itemId,
    conferidoPorId: usuarioId,
    quantidadeConferida: 0,
    motivo: 'Não encontrado no local',
  });
}

// ---------------------------------------------------------------------------
// Encerrar um prédio: o colaborador declara que varreu aquele endereço
// ---------------------------------------------------------------------------

// Os dois caminhos são decisões diferentes e o colaborador escolhe na hora:
//
// NAO_ENCONTRADOS — varri o prédio e o que sobrou não estava lá. Registra 0
//   nos pendentes, que é o que um inventário físico de fato afirma. Vira
//   divergência de verdade no relatório, então o app diz quantos antes.
// DEIXAR_PENDENTE — terminei a minha parte, o resto fica pra outra pessoa.
//   Não toca em item nenhum; só tira o prédio da frente de quem encerrou.
export type ModoEncerramento = 'NAO_ENCONTRADOS' | 'DEIXAR_PENDENTE';

export interface EncerrarPredioInput {
  tarefaId: string;
  usuarioId: string;
  empresaCodigo: string;
  rua: string | null;
  predio: string | null;
  // Quem encerra é quem está na prateleira, e a prateleira é o nível.
  nivel: string | null;
  modo: ModoEncerramento;
}

export interface PredioEncerradoDTO {
  tarefaId: string;
  empresaCodigo: string;
  rua: string | null;
  predio: string | null;
  nivel: string | null;
  pendentes: number;
  encerradoEm: string;
}

function paraTexto(valor: string | null): string {
  return valor ?? '';
}

function paraNulo(valor: string): string | null {
  return valor === '' ? null : valor;
}

export async function encerrarPredio(
  input: EncerrarPredioInput
): Promise<{ registradosZero: number; pendentes: number }> {
  // Só o que É desta pessoa e ainda não produziu número nenhum. Item em 2ª
  // contagem tem outro dono e outra regra: registrar 0 nele seria apagar a
  // recontagem que o gestor pediu.
  const abertos = await prisma.contagemItem.findMany({
    where: {
      tarefaId: input.tarefaId,
      empresaCodigo: input.empresaCodigo,
      rua: input.rua,
      predio: input.predio,
      nivel: input.nivel,
      status: { in: ['PENDENTE', 'EM_ANDAMENTO'] },
      quantidadeConferida: null,
      atribuidoParaId: input.usuarioId,
    },
    select: { id: true },
  });

  let registradosZero = 0;
  if (input.modo === 'NAO_ENCONTRADOS') {
    // Em série, não em paralelo: cada registro dispara notificação e releitura
    // de saldo, e trinta ao mesmo tempo derrubariam a conexão do Sankhya.
    for (const item of abertos) {
      await registrarNaoEncontrado(item.id, input.usuarioId);
      registradosZero += 1;
    }
  }

  const pendentes = input.modo === 'NAO_ENCONTRADOS' ? 0 : abertos.length;

  const chave = {
    tarefaId: input.tarefaId,
    usuarioId: input.usuarioId,
    empresaCodigo: input.empresaCodigo,
    rua: paraTexto(input.rua),
    predio: paraTexto(input.predio),
    nivel: paraTexto(input.nivel),
  };

  // findFirst + create/update em vez de upsert: o upsert pede o nome exato do
  // índice único, e mudar o índice (como acabou de acontecer com o nível)
  // quebra o código que ainda está no ar até o deploy sair.
  const existente = await prisma.predioEncerrado.findFirst({ where: chave, select: { id: true } });
  if (existente) {
    await prisma.predioEncerrado.update({
      where: { id: existente.id },
      data: { pendentes, encerradoEm: new Date() },
    });
  } else {
    await prisma.predioEncerrado.create({ data: { ...chave, pendentes } });
  }

  return { registradosZero, pendentes };
}

// Encerrar não pode ser porta de mão única: quem fechou o prédio sem querer
// precisa conseguir voltar. O que foi registrado como 0 continua registrado —
// desfazer contagem é outra coisa, e é decisão do gestor.
export async function reabrirPredio(input: {
  tarefaId: string;
  usuarioId: string;
  empresaCodigo: string;
  rua: string | null;
  predio: string | null;
  nivel: string | null;
}): Promise<void> {
  await prisma.predioEncerrado.deleteMany({
    where: {
      tarefaId: input.tarefaId,
      usuarioId: input.usuarioId,
      empresaCodigo: input.empresaCodigo,
      rua: paraTexto(input.rua),
      predio: paraTexto(input.predio),
      nivel: paraTexto(input.nivel),
    },
  });
}

export async function getPrediosEncerrados(
  tarefaId: string,
  usuarioId?: string
): Promise<PredioEncerradoDTO[]> {
  const linhas = await prisma.predioEncerrado.findMany({
    where: { tarefaId, ...(usuarioId ? { usuarioId } : {}) },
  });

  return linhas.map((linha) => ({
    tarefaId: linha.tarefaId,
    empresaCodigo: linha.empresaCodigo,
    rua: paraNulo(linha.rua),
    predio: paraNulo(linha.predio),
    nivel: paraNulo(linha.nivel),
    pendentes: linha.pendentes,
    encerradoEm: linha.encerradoEm.toISOString(),
  }));
}

// ---------------------------------------------------------------------------
// Contagem avulsa: o operador escolhe o endereço, sem esperar atribuição
// ---------------------------------------------------------------------------

export interface ContagemAvulsaInput {
  usuarioId: string;
  codigoProduto: string;
  quantidadeConferida: number;
  // Rótulo do lote, pra achar essas contagens depois na aba Contagens.
  tarefaNome?: string;
  // Os bipes ficam como evidência de que a pessoa esteve na prateleira. Não
  // recortam nada: a avulsa continua conferindo contra o saldo do produto
  // somado na loja inteira, porque o endereço é justamente o que não se sabe.
  codigoLocalBipado?: string;
  codigoProdutoBipado?: string;
  motivo?: string;
  observacao?: string;
}

// Contagem avulsa: produto e quantidade, sem endereço nenhum.
//
// Antes ela pedia o bipe da prateleira e trazia os itens daquele local — o
// que entregava ao operador a lista do que o sistema achava que estava ali.
// Agora ele digita o produto e o quanto contou, e nada do sistema aparece na
// tela: a contagem é cega de ponta a ponta.
//
// Sem endereço, o que sobra pra conferir é o saldo do PRODUTO somado em
// todos os locais da loja dele. Vale a mesma regra de reserva da contagem
// normal: bater com o disponível OU com o total conta como acerto.
export async function registrarContagemAvulsa(
  input: ContagemAvulsaInput
): Promise<{ item: ContagemItemDTO; esperado: number; locais: number }> {
  const usuario = await prisma.usuario.findUnique({ where: { id: input.usuarioId } });
  if (!usuario) throw new Error('Usuário não encontrado.');
  if (!Number.isFinite(input.quantidadeConferida) || input.quantidadeConferida < 0) {
    throw new Error('Informe a quantidade contada.');
  }

  const prefixo = ehFilial(usuario.filial) ? prefixoDaFilial(usuario.filial) : undefined;
  const base = await getSaldoTotalDoProduto(input.codigoProduto, prefixo);
  if (!base) throw new Error('Não achei esse produto no Sankhya. Confira o código.');
  if (input.codigoProdutoBipado) await conferirBipeDoProduto(base, input.codigoProdutoBipado);

  const bateuDisponivel = input.quantidadeConferida === base.quantidadeDisponivel;
  const bateuTotal = input.quantidadeConferida === base.quantidadeTotal;
  const diferenca =
    bateuDisponivel || bateuTotal ? 0 : input.quantidadeConferida - base.quantidadeDisponivel;

  // O código do local carrega o prefixo da loja porque é dele que sai a
  // filial em todo o resto do sistema (ver src/lib/filiais.ts). Sem isso a
  // contagem avulsa sumiria dos filtros por loja.
  const localCodigo = `${prefixo ?? ''}AVULSA`;

  const ciclo = await garantirCicloAberto(input.usuarioId);
  const rotuloTarefa = input.tarefaNome?.trim() || `Avulsa · ${new Date().toLocaleDateString('pt-BR')}`;
  const tarefaId = await acharOuCriarTarefa(rotuloTarefa, ciclo.id, input.usuarioId, [input.usuarioId]);
  const agora = new Date();

  const criado = await prisma.contagemItem.create({
    data: {
      cicloId: ciclo.id,
      tarefaId,
      empresaCodigo: base.empresaCodigo,
      empresaNome: base.empresaNome,
      codigoProduto: base.codigoProduto,
      descricao: base.descricao,
      unidade: base.unidade,
      local: 'Contagem avulsa (sem endereço)',
      localCodigo,
      quantidadeEsperada: base.quantidadeDisponivel,
      quantidadeTotal: base.quantidadeTotal,
      quantidadeReservada: base.quantidadeReservada,
      dataSaldo: agora,
      rua: null,
      predio: null,
      nivel: null,
      tarefaNome: rotuloTarefa,
      status: diferenca === 0 ? 'CONFERIDA' : 'DIVERGENCIA',
      atribuidoParaId: input.usuarioId,
      atribuidoPorId: input.usuarioId,
      iniciadoPorId: input.usuarioId,
      iniciadoEm: agora,
      quantidadeConferida: input.quantidadeConferida,
      diferenca,
      motivo: diferenca !== 0 ? (input.motivo ?? 'Contagem avulsa') : null,
      observacao: input.observacao?.trim() || null,
      codigoLocalBipado: input.codigoLocalBipado ?? null,
      codigoProdutoBipado: input.codigoProdutoBipado ?? null,
      conferidoPorId: input.usuarioId,
      dataConferencia: agora,
    },
  });

  const nome = await nomeUsuario(input.usuarioId);
  await criarNotificacao(
    diferenca === 0 ? 'FIM_CONTAGEM' : 'DIVERGENCIA',
    criado.id,
    diferenca === 0 ? 'Contagem avulsa registrada' : 'Divergência em contagem avulsa',
    `${nome} contou ${input.quantidadeConferida} de ${base.descricao}` +
      (diferenca === 0
        ? '.'
        : ` — o sistema tem ${base.quantidadeDisponivel} em ${base.locais} local(is).`)
  );

  return { item: montarContagemItemDTO(criado), esperado: base.quantidadeDisponivel, locais: base.locais };
}

// ---------------------------------------------------------------------------
// Apagar contagens
// ---------------------------------------------------------------------------

// Apaga itens de contagem escolhidos a dedo. Existe porque sobrou lixo de
// épocas anteriores (itens criados a partir da cópia de estoque, que mandam
// contar prateleira vazia) e porque um erro de atribuição não deveria ficar
// pra sempre inflando a divergência do inventário.
//
// Registra quem apagou e o que foi apagado: é contagem de gente, não rascunho.
export async function apagarContagemItens(
  ids: string[],
  usuarioId: string
): Promise<{ apagados: number }> {
  if (ids.length === 0) throw new Error('Escolha ao menos um item para apagar.');

  const itens = await prisma.contagemItem.findMany({ where: { id: { in: ids } } });
  if (itens.length === 0) throw new Error('Nenhum dos itens escolhidos existe mais.');

  const contados = itens.filter((i) => i.quantidadeConferida !== null).length;
  await prisma.contagemItem.deleteMany({ where: { id: { in: itens.map((i) => i.id) } } });

  const nome = await nomeUsuario(usuarioId);
  await criarNotificacao(
    'CONTAGEM_APAGADA',
    itens[0].id,
    'Contagem apagada',
    `${nome} apagou ${itens.length} ite${itens.length === 1 ? 'm' : 'ns'} da contagem` +
      (contados > 0
        ? `, ${contados} deles já contado(s). Essas contagens saíram do histórico.`
        : ' que ninguém tinha contado ainda.')
  );

  return { apagados: itens.length };
}
