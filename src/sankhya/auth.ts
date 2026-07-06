import { env } from '../lib/env';

// Autenticação OAuth2 (client_credentials) do Gateway do Sankhya.
// Docs: https://developer.sankhya.com.br/reference/post_authenticate

interface RespostaAutenticacao {
  access_token: string;
  token_type: string;
  expires_in: number;
}

interface TokenEmCache {
  accessToken: string;
  expiraEm: number; // epoch ms
}

let cache: TokenEmCache | null = null;

async function autenticar(): Promise<TokenEmCache> {
  const corpo = new URLSearchParams({
    client_id: env.sankhya.clientId,
    client_secret: env.sankhya.clientSecret,
    grant_type: 'client_credentials',
  });

  const resposta = await fetch(`${env.sankhya.baseUrl}/authenticate`, {
    method: 'POST',
    headers: {
      'X-Token': env.sankhya.xToken,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: corpo,
  });

  if (!resposta.ok) {
    throw new Error(
      `Falha ao autenticar no Sankhya (HTTP ${resposta.status}): ${await resposta.text()}`
    );
  }

  const dados = (await resposta.json()) as RespostaAutenticacao;

  return {
    accessToken: dados.access_token,
    // Renova um pouco antes de expirar de verdade (margem de segurança de 60s).
    expiraEm: Date.now() + Math.max(dados.expires_in - 60, 0) * 1000,
  };
}

export async function obterTokenSankhya(): Promise<string> {
  if (cache && Date.now() < cache.expiraEm) {
    return cache.accessToken;
  }

  cache = await autenticar();
  return cache.accessToken;
}
