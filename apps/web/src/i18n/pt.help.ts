import type { HelpPack } from './index';

const help: HelpPack = {
  topics: {
    buying: { title: 'Comprar', blurb: 'Encontrar anúncios, fazer pedidos e receber o que você comprou.' },
    protection: { title: 'Disputas e proteção', blurb: 'Custódia, prazo de inspeção, seguro e reembolsos.' },
    payments: { title: 'Pagamentos', blurb: 'Cartões, cripto, moedas e crédito na loja.' },
    selling: { title: 'Vender', blurb: 'Anúncios, entrega, taxas e recebimentos.' },
    account: { title: 'Conta e segurança', blurb: 'Verificação, login em duas etapas e seus dados.' },
  },
  articles: {
    'how-escrow-works': {
      title: 'Como a custódia protege seu pedido',
      summary: 'Seu pagamento fica com a gente até você ter o que pagou.',
      body: [
        'Quando você paga, o dinheiro vai para a custódia, não para o vendedor. O vendedor só vê que o pedido foi pago e pode entregar.',
        'Depois da entrega, você tem um prazo de proteção para conferir tudo: 72 horas para keys, moedas, itens, recargas e boosting, e 14 dias de seguro para contas de jogos.',
        'O vendedor recebe quando você confirma o pedido ou quando o prazo termina sem disputa, o que vier primeiro. Se algo estiver errado, abra uma disputa pela página do pedido antes do fim do prazo e o dinheiro fica congelado até a decisão.',
      ],
    },
    'order-not-delivered': {
      title: 'Meu pedido não foi entregue',
      summary: 'O que fazer quando o vendedor atrasa e quando você recebe o dinheiro de volta automaticamente.',
      body: [
        'Anúncios com entrega imediata são entregues assim que o pagamento é aprovado; confira a página do pedido. Em anúncios manuais, o vendedor promete um prazo de entrega que aparece no anúncio.',
        'Fale primeiro com o vendedor no chat do pedido; a maioria dos atrasos se resolve ali. Se o prazo prometido passar, lembramos o vendedor, e se ele ainda não entregar, o pedido é cancelado e reembolsado automaticamente.',
        'Você também pode abrir uma disputa pela página do pedido a qualquer momento enquanto o pagamento estiver em custódia.',
      ],
    },
    'open-a-dispute': {
      title: 'Abrir uma disputa',
      summary: 'Quando algo não é como o anunciado, um árbitro decide com base no chat do pedido e nas provas.',
      body: [
        'Abra uma disputa pela página do pedido enquanto ele estiver no prazo de proteção. Explique o problema e adicione capturas de tela ao chat do pedido.',
        'O pagamento fica congelado enquanto um árbitro da Bullizard analisa o chat, os registros de entrega e as provas dos dois lados.',
        '- Se o árbitro decidir a seu favor, o valor total volta para o seu meio de pagamento original.\n- Se decidir a favor do vendedor, o pagamento é liberado para ele.',
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
    'game-fields-and-filters': {
      title: 'Filtrar por servidor, região, plataforma e elo',
      summary: 'Use os seletores da página de cada jogo para ver só os anúncios que servem para você.',
      body: [
        'Muitos jogos dividem o mercado: League of Legends por servidor, Valorant por região, World of Warcraft por reino e facção, skins de CS2 por desgaste. Abra um jogo, escolha uma categoria e use os seletores acima da tabela de anúncios.',
        'Cada opção mostra quantos anúncios ativos ela tem com os outros filtros aplicados. Os vendedores precisam preencher esses campos, então os filtros são confiáveis.',
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
      title: 'Formas de pagamento',
      summary: 'Cartão por checkout seguro hospedado, ou USDC/USDT por contrato de custódia on-chain.',
      body: [
        'Pagamentos com cartão passam pela página segura do nosso parceiro; nunca vemos o número do seu cartão. Você paga o preço mostrado no checkout, na moeda do anúncio.',
        'Pagamentos em cripto usam um contrato de custódia on-chain com o mesmo prazo de proteção. Envie apenas o valor exato para o endereço do contrato mostrado para o seu pedido.',
        'Preços exibidos em outra moeda são conversões aproximadas; o checkout sempre mostra o valor exato que será cobrado.',
      ],
    },
    'refund-timing': {
      title: 'Quando vou ver meu reembolso?',
      summary: 'Reembolsos voltam ao meio de pagamento original; os bancos levam alguns dias.',
      body: [
        'Reembolsos voltam para o cartão ou carteira usados no pagamento. Enviamos reembolsos no cartão na hora; seu banco costuma mostrar em 5 a 10 dias úteis.',
        'Crédito na loja (de promoções ou indicações) volta como crédito na loja imediatamente.',
      ],
    },
    'selling-fees': {
      title: 'Taxas e níveis de vendedor',
      summary: 'As taxas caem conforme suas vendas de 30 dias crescem; gift cards, recargas e videogames têm taxa menor.',
      body: [
        'Cada venda paga uma comissão que depende do seu nível de vendedor, definido pelas vendas dos últimos 30 dias. Contas têm taxa própria; gift cards, recargas e videogames pagam 4,99%.',
        'Você vê a taxa exata e o ganho líquido em cada pedido, e seu nível e progresso no painel do vendedor.',
      ],
    },
    'getting-paid': {
      title: 'Recebendo',
      summary: 'Saque para o seu banco em USD, EUR ou GBP quando o prazo de proteção terminar.',
      body: [
        'O dinheiro de uma venda fica disponível quando o comprador confirma ou quando o prazo de proteção termina. Saque pelo painel do vendedor para a conta bancária cadastrada na página do nosso parceiro de pagamentos.',
        'Vendedores novos podem ter uma breve retenção de saque enquanto criamos confiança; o painel mostra quando o valor retido é liberado.',
        'Se um reembolso ou chargeback deixar seu saldo negativo, novas vendas cobrem o valor primeiro e os saques ficam pausados até a quitação.',
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
    'verify-identity': {
      title: 'Verificando sua identidade',
      summary: 'Nível 1 para comprar, nível 2 (documento com foto) para vender.',
      body: [
        'O nível 1 é um e-mail e um telefone verificados; basta para comprar. O nível 2 adiciona um documento com foto e uma prova de vida com nosso parceiro de verificação, e é obrigatório para vender.',
        'A verificação costuma levar poucos minutos. Se falhar, confira se a foto está nítida e se todos os cantos do documento aparecem, e tente de novo.',
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
