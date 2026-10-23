import type { HelpPack } from './index';

const help: HelpPack = {
  topics: {
    buying: { title: 'Comprar', blurb: 'Encontrar anúncios, fazer pedidos e receber o que você comprou.' },
    protection: { title: 'Disputas e proteção', blurb: 'Proteção ao comprador, custódia, seguro e reembolsos.' },
    payments: { title: 'Pagamentos', blurb: 'Cripto, taxas de rede, sua carteira e reembolsos.' },
    selling: { title: 'Vender', blurb: 'Anúncios, entrega, taxas e recebimentos.' },
    account: { title: 'Conta e segurança', blurb: 'Verificação, login em duas etapas e seus dados.' },
  },
  articles: {
    'open-a-dispute': {
      title: "Abrir uma disputa",
      summary: "Quando algo não é como descrito, um árbitro decide com o chat do pedido e as provas.",
      body: [
        "Abra uma disputa na página do pedido antes de confirmá-lo. Explique o problema e adicione capturas de tela no chat do pedido.",
        "O pagamento fica congelado enquanto um árbitro da Bullizard analisa o chat, os registros de entrega e as provas dos dois lados.",
        "- Se o árbitro decidir a seu favor, o valor total volta para o seu saldo Bullizard.\n- Se decidir a favor do vendedor, o pagamento é liberado para ele.",
      ],
    },
    'account-insurance': {
      title: 'Seguro de contas e prova de dono',
      summary: 'Por que anúncios de contas têm 14 dias de seguro e o que significa “dono verificado”.',
      body: [
        'Um dono anterior pode recuperar uma conta, por isso pedidos de contas têm seguro de 14 dias após a entrega: se a conta for recuperada nesse período, você é reembolsado.',
        'Anúncios com dono verificado vêm do dono original, que nos mostrou o e-mail de cadastro e recibos das primeiras compras. Os que não têm isso são marcados como alto risco; a custódia e o seguro continuam valendo.',
        'Depois da entrega, troque imediatamente o e-mail, a senha e a verificação em duas etapas.',
      ],
    },
    'price-alerts': {
      title: 'Lista de acompanhamento e alertas de preço',
      summary: 'Acompanhe um anúncio ou um mercado inteiro e saiba de cada novo preço mais baixo.',
      body: [
        'Use “Alerta de preço” em um anúncio ou “Avise-me de novos preços baixos” na página de um jogo (seus filtros de servidor ou região são mantidos). Você pode definir um preço-alvo ou deixar vazio para saber de qualquer queda.',
        'Verificamos a cada poucos minutos e avisamos uma vez a cada novo preço mais baixo, e também quando um anúncio esgotado volta ao estoque. Gerencie tudo na sua lista de acompanhamento.',
      ],
    },
    'payment-methods': {
      title: "Formas de pagamento",
      summary: "Pague em cripto: escolha uma moeda popular; a taxa de rede é somada ao total.",
      body: [
        "O pagamento é em cripto. Escolha uma moeda da lista; cada uma mostra sua rede (por exemplo TRC-20) e o total a enviar.",
        "A taxa de rede da moeda é somada: um pedido de $11,50 com $1,00 de taxa significa que você envia $12,50. Só o valor do pedido vai para o vendedor.",
        "Envie o valor exato para o endereço mostrado, na mesma rede. O pedido fica pago quando a rede confirma. Moedas com mínimo acima do seu pedido aparecem em cinza.",
        "O dinheiro do seu saldo Bullizard é usado primeiro.",
      ],
    },
    'delivery-in-game': {
      title: 'Como funciona a entrega no jogo',
      summary: 'Moeda e itens são negociados para o nome de personagem que você confirma no checkout; o vendedor anexa uma prova e você libera o pagamento.',
      body: [
        'Em jogos com entrega dentro do jogo (moeda, itens, recargas), você informa o nome de personagem ou UID exato com que o vendedor deve negociar. Ele é confirmado com um toque no checkout e lembrado para o próximo pedido; confira com cuidado, porque o vendedor entrega para esse nome e você é responsável por ele estar certo.',
        'O vendedor negocia com esse personagem e anexa uma foto ou vídeo da troca antes de marcar o pedido como entregue. A prova fica visível na página do pedido.',
        'O pagamento fica em custódia até você confirmar o recebimento. Se algo estiver errado, abra uma disputa na página do pedido em vez de confirmar; a equipe compara a prova com a troca e decide.',
      ],
    },
    'seller-analytics': {
      title: 'Entendendo as estatísticas da sua loja',
      summary: 'Visualizações, conversão e compradores recorrentes, e como são contados.',
      body: [
        'A aba Estatísticas mostra vendas, visualizações de anúncios, conversão (pedidos divididos por visualizações), ticket médio e compradores recorrentes, comparados com o período anterior.',
        'Uma visualização conta uma vez por visitante, anúncio e hora, e nunca quando você olha seu próprio anúncio.',
      ],
    },
    'two-factor': {
      title: 'Verificação em duas etapas e segurança',
      summary: 'Ative um app autenticador e nunca compartilhe códigos no chat do pedido.',
      body: [
        'Ative a verificação em duas etapas em Conta → Segurança com qualquer app autenticador e guarde seus códigos de recuperação em local seguro.',
        'A equipe da Bullizard nunca vai pedir sua senha ou um código de acesso. Mantenha as negociações no chat do pedido: acordos levados para outros apps não são protegidos pela custódia.',
      ],
    },
    'report-a-user': {
      title: 'Denunciar tentativa de golpe ou abuso',
      summary: 'Conte para a gente sobre pedidos de pagamento fora da plataforma, links de phishing ou assédio.',
      body: [
        'Se alguém pedir para você pagar fora da Bullizard, mandar um link suspeito ou for abusivo, não responda mais. Envie uma solicitação na categoria “Denunciar um usuário” com o nome da pessoa e o pedido ou chat em que aconteceu.',
        'Nossa equipe de confiança e segurança analisa toda denúncia. Nem sempre podemos contar o resultado, mas tomamos providências.',
      ],
    },
    'wallet': {
      title: "Sua carteira",
      summary: "Seu saldo e cada movimentação em uma só lista.",
      body: [
        "Abra Carteira no menu da conta. No topo fica seu saldo; abaixo, cada pedido, reembolso, venda e saque.",
        "- Amarelo, Retido: o dinheiro está em custódia até o pedido ser confirmado.\n- Verde, Concluído: pronto.\n- Vermelho, Cancelado: o pedido ou saque foi cancelado.\n- Cinza, Pendente: aguardando pagamento ou aprovação.",
        "Vendedores veem suas vendas na mesma lista. Pagamentos e documentos fiscais ficam no painel do vendedor, em Dinheiro.",
      ],
    },
    'sell-by-amount': {
      title: "Vender moeda por quantidade",
      summary: "Defina unidade, preço por unidade, mínimo e estoque; o comprador escolhe quanto.",
      body: [
        "No formulário de venda escolha Moeda e informe a unidade, por exemplo M para milhões de prata. O preço passa a ser por unidade.",
        "Defina seu estoque e o pedido mínimo, ambos em unidades. O comprador escolhe qualquer quantidade entre seu mínimo e seu estoque, e o total se atualiza.",
        "Na página do jogo sua oferta aparece na tabela de vendedores com servidor, estoque, mínimo, prazo de entrega e preço por unidade.",
      ],
    },
    'seller-badges': {
      title: "Seus selos e sua loja",
      summary: "Escolha os 2 selos que os compradores veem ao lado do seu nome.",
      body: [
        "Você ganha selos ao vender: seu nível, Vendedor fundador, ID verificado e Top vendedor. No painel do vendedor, na sua loja, escolha até 2 para mostrar ao lado do seu nome nas ofertas.",
        "Sua loja também mostra os idiomas que você fala, sua apresentação e seus números: avaliações positivas, nota, pedidos vendidos e entregas no prazo.",
      ],
    },
  },
  ticketCategories: {
    order: 'Um problema com um pedido',
    payment: 'Pagamentos e reembolsos',
    account: 'Minha conta ou verificação',
    selling: 'Vendas e saques',
    report: 'Denunciar um usuário',
    other: 'Outra coisa',
  },
};
export default help;
