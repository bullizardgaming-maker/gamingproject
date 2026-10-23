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
    'how-escrow-works': {
      title: "Como a custódia protege seu pedido",
      summary: "Seu pagamento fica conosco até você confirmar que recebeu o que pagou.",
      body: [
        "Quando você paga, o dinheiro vai para a custódia, não para o vendedor. O vendedor só vê que o pedido está pago e pode entregar.",
        "Não há cronômetro: o dinheiro fica em custódia até você confirmar que recebeu o pedido. Confirme só quando tiver tudo.",
        "Se algo der errado, abra uma disputa na página do pedido em vez de confirmar. O dinheiro fica congelado até a resolução.",
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
      title: "Formas de pagamento",
      summary: "Pague em cripto: escolha uma moeda popular; a taxa de rede é somada ao total.",
      body: [
        "O pagamento é em cripto. Escolha uma moeda da lista; cada uma mostra sua rede (por exemplo TRC-20) e o total a enviar.",
        "A taxa de rede da moeda é somada: um pedido de $11,50 com $1,00 de taxa significa que você envia $12,50. Só o valor do pedido vai para o vendedor.",
        "Envie o valor exato para o endereço mostrado, na mesma rede. O pedido fica pago quando a rede confirma. Moedas com mínimo acima do seu pedido aparecem em cinza.",
        "O dinheiro do seu saldo Bullizard é usado primeiro.",
      ],
    },
    'refund-timing': {
      title: "Quando vejo meu reembolso?",
      summary: "Reembolsos caem no seu saldo Bullizard na hora.",
      body: [
        "Quando um pedido é reembolsado, o dinheiro vai para o seu saldo Bullizard na hora. Você vê na página Carteira.",
        "Use no próximo pedido ou saque para sua carteira cripto (USDT TRC-20). Há uma taxa de saque e a tesouraria envia após aprovar.",
      ],
    },
    'selling-fees': {
      title: 'Comissão e patentes de vendedor',
      summary: 'Você define o preço e o recebe integralmente; a comissão entra por cima para o comprador e cai conforme sua patente sobe.',
      body: [
        'Você digita o preço que quer. A comissão da sua patente entra por cima para o comprador, então o valor digitado é exatamente o que cai no seu saldo quando o pedido é concluído. As patentes são definidas pelas vendas concluídas nos últimos 30 dias; vendedores novos pagam uma taxa de lançamento reduzida nos primeiros 60 dias.',
        'O formulário de venda mostra, antes de publicar, o que os compradores pagarão em cada moeda e o que sobra para você após a taxa de saque. Sua patente e progresso ficam no painel do vendedor.',
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
    'getting-paid': {
      title: 'Recebendo',
      summary: 'Saque para sua carteira cripto (USDT) quando o comprador confirmar; há uma taxa de 6%.',
      body: [
        'O dinheiro de uma venda fica disponível quando o comprador confirma o pedido. Saque pelo painel do vendedor para o endereço de recebimento confirmado por e-mail; a tesouraria aprova e envia em USDT.',
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
    'buyer-protection': {
      title: "Proteção ao comprador Bullizard",
      summary: "Seu dinheiro só chega ao vendedor quando você confirma que recebeu o pedido.",
      body: [
        "Quando você paga, a Bullizard guarda o dinheiro. O vendedor vê que o pedido está pago e entrega.",
        "O vendedor só recebe quando você confirma que recebeu o pedido. Você pode confirmar assim que tiver, mesmo antes de o vendedor marcar como entregue.",
        "- Não entregue no prazo prometido: o pedido é cancelado e você é reembolsado.\n- Diferente do anunciado: abra uma disputa na página do pedido antes de confirmar. O dinheiro fica congelado até um árbitro da Bullizard decidir.\n- Contas de jogo: 14 dias de seguro após a entrega.",
        "Mantenha toda a negociação no chat do pedido. Acordos fora da Bullizard não são protegidos.",
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
