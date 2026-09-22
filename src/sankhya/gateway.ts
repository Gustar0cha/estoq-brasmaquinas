import { invalidarTokenSankhya, obterTokenSankhya } from './auth';
import { env } from '../lib/env';

// Executa SQL via DbExplorerSP.executeQuery (API Gateway do Sankhya).
// Docs: https://community.sankhya.com.br/developers/conectividade/post/api---dbexplorersp-executequery-kBAx9OeMMJz0sFJ
//
// A resposta vem em formato "colunar": `fieldsMetadata` traz os nomes das
// colunas, na mesma ordem dos valores de cada array em `rows`. Esta função
// já converte isso para uma lista de objetos { nomeDaColuna: valor }, então
// o resto do backend nunca precisa lidar com esse formato bruto.
//
// Limitação conhecida do serviço: retorna no máximo ~1000 linhas por chamada
// (por isso a query em client.ts usa uma janela de dias, não o histórico todo).

interface FieldMetadata {
  name: string;
}

interface ExecuteQueryResponse {
  status: string;
  statusMessage?: string;
  responseBody?: {
    fieldsMetadata: FieldMetadata[];
    rows: unknown[][];
  };
}

// O Sankhya recusa um token com "Não autorizado" mesmo dentro da validade que
// ele próprio informou (o token dura 300s, e a sessão pode cair antes). Como
// a falha é transitória, vale uma segunda tentativa com token novo — sem isso
// o usuário só via "Sankhya retornou erro na consulta: Não autorizado".
function ehFalhaDeAutorizacao(erro: unknown): boolean {
  const mensagem = erro instanceof Error ? erro.message.toLowerCase() : '';
  return (
    mensagem.includes('não autorizado') ||
    mensagem.includes('nao autorizado') ||
    mensagem.includes('unauthorized') ||
    mensagem.includes('http 401')
  );
}

// O gateway trabalha numa sessão HTTP só, e o Sankhya RECUSA duas consultas
// simultâneas nela: "O serviço foi cancelado por situação de concorrência.
// Essa mesma sessão HTTP fez a requisição duas vezes simultaneamente."
//
// Não é erro de quem chama — é limite do serviço. Então a fila fica aqui, e
// não espalhada em cada chamador lembrando de não usar Promise.all. Cada
// consulta espera a anterior terminar; o `catch` vazio impede que uma falha
// trave a fila pras seguintes.
let fila: Promise<unknown> = Promise.resolve();

function enfileirar<T>(tarefa: () => Promise<T>): Promise<T> {
  const resultado = fila.then(tarefa, tarefa);
  fila = resultado.catch(() => undefined);
  return resultado;
}

export async function executarQuery<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  return enfileirar(async () => {
    try {
      return await executarUmaVez<T>(sql);
    } catch (erro) {
      if (!ehFalhaDeAutorizacao(erro)) throw erro;

      invalidarTokenSankhya();
      return executarUmaVez<T>(sql);
    }
  });
}

async function executarUmaVez<T>(sql: string): Promise<T[]> {
  const token = await obterTokenSankhya();

  const resposta = await fetch(
    `${env.sankhya.baseUrl}/gateway/v1/mge/service.sbr?serviceName=DbExplorerSP.executeQuery&outputType=json`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        serviceName: 'DbExplorerSP.executeQuery',
        requestBody: { sql },
      }),
    }
  );

  if (!resposta.ok) {
    throw new Error(`Falha ao consultar o Sankhya (HTTP ${resposta.status}): ${await resposta.text()}`);
  }

  const dados = (await resposta.json()) as ExecuteQueryResponse;

  if (dados.status !== '1' || !dados.responseBody) {
    throw new Error(`Sankhya retornou erro na consulta: ${dados.statusMessage ?? JSON.stringify(dados)}`);
  }

  const { fieldsMetadata, rows } = dados.responseBody;

  return rows.map((linha) => {
    const objeto: Record<string, unknown> = {};
    fieldsMetadata.forEach((campo, indice) => {
      objeto[campo.name] = linha[indice];
    });
    return objeto as T;
  });
}
