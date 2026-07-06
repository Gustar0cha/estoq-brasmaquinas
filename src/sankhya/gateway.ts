import { obterTokenSankhya } from './auth';
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

export async function executarQuery<T = Record<string, unknown>>(sql: string): Promise<T[]> {
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
