const axios = require('axios');

// Prompts usados para cada tipo de documento — mesmos textos que já rodavam no navegador
const PROMPTS = {
  cupom: function(hoje) {
    return 'Analise este cupom. JSON apenas: {"descricao":"loja","valor":0.00,"data":"YYYY-MM-DD","categoria":"Alimentacao","itens":"resumo"}. data: ' + hoje + ' se nao encontrar.';
  },
  boleto: function(hoje) {
    return 'Analise este documento. JSON apenas: {"nome":"empresa","valor_total":0.00,"num_parcelas":1,"valor_parcela":0.00,"primeiro_vencimento":"YYYY-MM-DD","categoria":"Outros","obs":"detalhes"}. vencimento: ' + hoje + ' se nao encontrar.';
  },
};

// Envia a imagem para a Claude API usando a chave guardada só no servidor
// (nunca exposta ao navegador) e devolve o JSON já interpretado.
async function analisarImagem(base64, mediaType, tipo) {
  var promptFn = PROMPTS[tipo];
  if (!promptFn) throw new Error('Tipo de scanner inválido: ' + tipo);

  var hoje = new Date().toISOString().slice(0, 10);

  var resp = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-sonnet-4-6',
      max_tokens: tipo === 'boleto' ? 400 : 300,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
          { type: 'text', text: promptFn(hoje) },
        ],
      }],
    },
    {
      headers: {
        'x-api-key': process.env.CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
    }
  );

  var text = resp.data.content[0].text.trim().replace(/```json|```/g, '').trim();
  return JSON.parse(text);
}

module.exports = { analisarImagem };
