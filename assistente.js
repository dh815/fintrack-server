const axios = require('axios');

// Interpreta um comando em linguagem natural (texto, já vindo de fala ou digitado)
// e devolve um JSON estruturado dizendo o que o app deve fazer.
async function interpretarComando(mensagem, categorias, hoje) {
  const catsEntrada = (categorias && categorias.entrada) || [];
  const catsSaida = (categorias && categorias.saida) || [];

  const systemPrompt = `Você é o assistente do app financeiro Bolso Inteligente. Sua única função é interpretar um comando em linguagem natural e devolver APENAS um JSON, sem nenhum texto antes ou depois, sem markdown, sem crases.

Data de hoje: ${hoje}

Categorias de ENTRADA disponíveis: ${catsEntrada.join(', ') || 'nenhuma cadastrada'}
Categorias de SAÍDA disponíveis: ${catsSaida.join(', ') || 'nenhuma cadastrada'}

Existem 3 ações possíveis. Responda com UM dos formatos abaixo, escolhendo o mais adequado:

1) Usuário quer LANÇAR uma entrada ou saída:
{"acao":"registrar","tipo":"entrada" ou "saida","valor":numero,"categoria":"uma das categorias disponíveis (ou a mais parecida; se nenhuma combinar, use 'Outros')","descricao":"texto curto descrevendo","data":"AAAA-MM-DD"}

Regras pra "data": se o usuário não disser quando, use hoje (${hoje}). Se disser "ontem", calcule 1 dia antes. Se disser um dia da semana ou data específica, calcule a partir de hoje.

2) Usuário está PERGUNTANDO algo sobre os dados dele (quanto gastou, quanto ganhou, saldo, etc):
{"acao":"consultar","tipo":"saidas" ou "entradas" ou "saldo","categoria":"nome da categoria ou null se não especificou","periodo":"hoje" ou "semana" ou "mes_atual" ou "mes_passado" ou "ano"}

3) Não deu pra entender o comando:
{"acao":"desconhecido","motivo":"explicação breve e amigável do que faltou"}

Responda SOMENTE com o JSON.`;

  const response = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-sonnet-4-5',
      max_tokens: 300,
      system: systemPrompt,
      messages: [{ role: 'user', content: mensagem }],
    },
    {
      headers: {
        'x-api-key': process.env.CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
    }
  );

  const text = response.data.content[0].text;
  const clean = text.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

module.exports = { interpretarComando };
