import type { HelpPack } from './index';

const help: HelpPack = {
  topics: {
    buying: { title: 'Comprar', blurb: 'Encontrar ofertas, pedir y recibir lo que compraste.' },
    protection: { title: 'Disputas y protección', blurb: 'Garantía, plazo de inspección, seguro y reembolsos.' },
    payments: { title: 'Pagos', blurb: 'Tarjetas, cripto, monedas y saldo de tienda.' },
    selling: { title: 'Vender', blurb: 'Ofertas, entregas, comisiones y cobros.' },
    account: { title: 'Cuenta y seguridad', blurb: 'Verificación, inicio de sesión en dos pasos y tus datos.' },
  },
  articles: {
    'how-escrow-works': {
      title: 'Cómo protege la garantía tu pedido',
      summary: 'Tu pago espera con nosotros hasta que tengas lo que pagaste.',
      body: [
        'Cuando pagas, el dinero va a la garantía, no al vendedor. El vendedor solo ve que el pedido está pagado y puede entregarlo.',
        'Tras la entrega tienes un plazo de protección para comprobarlo todo: 72 horas para claves, moneda, objetos, recargas y boosting, y 14 días de seguro para cuentas de juego.',
        'El vendedor cobra cuando confirmas el pedido o cuando termina el plazo sin disputa, lo que ocurra antes. Si algo falla, abre una disputa desde la página del pedido antes de que termine el plazo y el dinero queda congelado hasta resolverla.',
      ],
    },
    'order-not-delivered': {
      title: 'Mi pedido no se ha entregado',
      summary: 'Qué hacer si el vendedor se retrasa y cuándo recuperas el dinero automáticamente.',
      body: [
        'Las ofertas de entrega instantánea se entregan en cuanto se confirma el pago; revisa la página del pedido. En las ofertas manuales, el vendedor promete un tiempo de entrega que aparece en la oferta.',
        'Escribe primero al vendedor en el chat del pedido; la mayoría de retrasos se resuelven ahí. Si pasa el plazo prometido, se lo recordamos al vendedor, y si aun así no entrega, el pedido se cancela y se te reembolsa automáticamente.',
        'También puedes abrir una disputa desde la página del pedido en cualquier momento mientras el pago esté en garantía.',
      ],
    },
    'open-a-dispute': {
      title: 'Abrir una disputa',
      summary: 'Si algo no es como se describía, un árbitro decide con el chat del pedido y las pruebas.',
      body: [
        'Abre una disputa desde la página del pedido mientras esté dentro del plazo de protección. Explica qué falla y añade capturas al chat del pedido.',
        'El pago queda congelado mientras un árbitro de Bullizard revisa el chat, los registros de entrega y las pruebas de ambas partes.',
        '- Si el árbitro te da la razón, se te reembolsa el importe íntegro en tu método de pago original.\n- Si se la da al vendedor, el pago se le libera.',
      ],
    },
    'account-insurance': {
      title: 'Seguro de cuentas y prueba de propietario',
      summary: 'Por qué las cuentas tienen 14 días de seguro y qué significa «propietario verificado».',
      body: [
        'Un dueño anterior puede recuperar una cuenta, así que los pedidos de cuentas están asegurados 14 días tras la entrega: si la cuenta se recupera en ese tiempo, te reembolsamos.',
        'Las ofertas con propietario verificado vienen del dueño original, que nos mostró el correo de registro y recibos de las primeras compras. Las que no lo tienen se marcan como de alto riesgo; la garantía y el seguro siguen aplicándose.',
        'Tras la entrega, cambia enseguida el correo, la contraseña y la verificación en dos pasos.',
      ],
    },
    'game-fields-and-filters': {
      title: 'Filtrar por servidor, región, plataforma y rango',
      summary: 'Usa los selectores de cada juego para ver solo las ofertas que te sirven.',
      body: [
        'Muchos juegos dividen su mercado: League of Legends por servidor, Valorant por región, World of Warcraft por reino y facción, las skins de CS2 por desgaste. Abre un juego, elige una categoría y usa los selectores sobre la tabla de ofertas.',
        'Cada opción muestra cuántas ofertas activas tiene con tus otros filtros aplicados. Los vendedores deben rellenar estos campos, así que los filtros son fiables.',
      ],
    },
    'price-alerts': {
      title: 'Lista de seguimiento y alertas de precio',
      summary: 'Sigue una oferta o un mercado entero y entérate de cada nuevo mínimo.',
      body: [
        'Usa «Alerta de precio» en una oferta o «Avísame de nuevos mínimos» en la página de un juego (mantiene tus filtros de servidor o región). Puedes fijar un precio objetivo o dejarlo vacío para enterarte de cualquier bajada.',
        'Revisamos cada pocos minutos y te avisamos una vez por cada nuevo mínimo, y cuando una oferta agotada vuelve a tener stock. Gestiónalo todo desde tu lista de seguimiento.',
      ],
    },
    'payment-methods': {
      title: 'Formas de pago',
      summary: 'Tarjeta en un pago seguro alojado, o USDC/USDT con un contrato de garantía en cadena.',
      body: [
        'Los pagos con tarjeta pasan por la página segura de nuestro socio de pagos; nunca vemos el número de tu tarjeta. Pagas el precio que aparece al pagar, en la moneda de la oferta.',
        'Los pagos con cripto usan un contrato de garantía en cadena con el mismo plazo de protección. Envía solo el importe exacto a la dirección del contrato indicada para tu pedido.',
        'Los precios en otra moneda son conversiones aproximadas; el pago siempre muestra el importe exacto que se te cobrará.',
      ],
    },
    'refund-timing': {
      title: '¿Cuándo veré mi reembolso?',
      summary: 'Los reembolsos vuelven al método de pago original; los bancos tardan unos días.',
      body: [
        'Los reembolsos vuelven a la tarjeta o billetera con la que pagaste. Enviamos los reembolsos con tarjeta al momento; tu banco suele mostrarlos en 5–10 días hábiles.',
        'El saldo de tienda (de promociones o referidos) se devuelve como saldo de tienda al instante.',
      ],
    },
    'selling-fees': {
      title: 'Comisión y rangos de vendedor',
      summary: 'Tú fijas tu precio y lo recibes íntegro; la comisión se añade encima para el comprador y baja a medida que sube tu rango.',
      body: [
        'Escribes el precio que quieres. La comisión de tu rango se añade encima para el comprador, así que la cantidad que escribiste es exactamente la que llega a tu saldo cuando el pedido se completa. Los rangos se fijan por tus ventas completadas en los últimos 30 días; los vendedores nuevos pagan una tasa de lanzamiento reducida durante sus primeros 60 días.',
        'El formulario de venta muestra, antes de publicar, lo que pagarán los compradores en cada moneda y lo que te queda tras la comisión de retiro. Tu rango y progreso están en el panel de vendedor.',
      ],
    },
    'delivery-in-game': {
      title: 'Cómo funciona la entrega en el juego',
      summary: 'La moneda y los objetos se intercambian al nombre de personaje que confirmas al pagar; el vendedor adjunta una prueba y tú liberas el pago.',
      body: [
        'En los juegos con entrega dentro del juego (moneda, objetos, recargas) indicas el nombre de personaje o UID exacto con el que debe comerciar el vendedor. Lo confirmas con un toque al pagar y se recuerda para tu próximo pedido; revísalo con cuidado, porque el vendedor entrega a ese nombre y tú eres responsable de que sea correcto.',
        'El vendedor comercia con ese personaje y adjunta una foto o vídeo del intercambio antes de marcar el pedido como entregado. Puedes ver la prueba en la página del pedido.',
        'El pago queda en custodia hasta que confirmes que recibiste los bienes. Si algo falla, abre una disputa desde la página del pedido en lugar de confirmar; el equipo compara la prueba con el intercambio y decide.',
      ],
    },
    'getting-paid': {
      title: 'Cobrar',
      summary: 'Retira a tu billetera cripto (USDT) cuando termine el plazo de protección; se aplica una comisión del 6 %.',
      body: [
        'El dinero de una venta queda disponible cuando el comprador confirma o termina el plazo de protección. Retíralo desde el panel de vendedor a la dirección de cobro que confirmaste por correo; tesorería lo aprueba y lo envía en USDT.',
        'Los vendedores nuevos pueden tener una breve retención de cobros mientras generamos confianza; el panel muestra cuándo se libera.',
        'Si un reembolso o contracargo deja tu saldo en negativo, las nuevas ventas lo cubren primero y los retiros se pausan hasta saldarlo.',
      ],
    },
    'seller-analytics': {
      title: 'Leer las estadísticas de tu tienda',
      summary: 'Visitas, conversión y compradores recurrentes, y cómo se cuentan.',
      body: [
        'La pestaña Estadísticas muestra ventas, visitas a ofertas, conversión (pedidos entre visitas), pedido medio y compradores recurrentes, comparados con el periodo anterior.',
        'Una visita cuenta una vez por visitante, oferta y hora, y nunca cuando miras tu propia oferta.',
      ],
    },
    'verify-identity': {
      title: 'Verificar tu identidad',
      summary: 'Nivel 1 para comprar; nivel 2 (documento con foto) para vender.',
      body: [
        'El nivel 1 es un correo y un teléfono verificados; basta para comprar. El nivel 2 añade un documento con foto y una prueba de vida con nuestro socio de verificación, y es necesario para vender.',
        'La verificación suele tardar unos minutos. Si falla, comprueba que la foto sea nítida y se vean todas las esquinas del documento, y vuelve a intentarlo.',
      ],
    },
    'two-factor': {
      title: 'Verificación en dos pasos y seguridad',
      summary: 'Activa una app de autenticación y nunca compartas códigos en el chat del pedido.',
      body: [
        'Activa la verificación en dos pasos en Cuenta → Seguridad con cualquier app de autenticación, y guarda tus códigos de recuperación en un lugar seguro.',
        'El equipo de Bullizard nunca te pedirá tu contraseña ni un código de acceso. Mantén las operaciones en el chat del pedido: los tratos llevados a otras apps no están protegidos por la garantía.',
      ],
    },
    'report-a-user': {
      title: 'Denunciar un intento de estafa o abuso',
      summary: 'Avísanos de peticiones de pago fuera de la plataforma, enlaces de phishing o acoso.',
      body: [
        'Si alguien te pide pagar fuera de Bullizard, te envía un enlace sospechoso o te acosa, no sigas respondiendo. Envíanos una solicitud en la categoría «Denunciar a un usuario» con su nombre y el pedido o chat donde ocurrió.',
        'Nuestro equipo de confianza y seguridad revisa cada denuncia. No siempre podemos contarte el resultado, pero actuamos.',
      ],
    },
  },
  ticketCategories: {
    order: 'Un problema con un pedido',
    payment: 'Pagos y reembolsos',
    account: 'Mi cuenta o la verificación',
    selling: 'Ventas y cobros',
    report: 'Denunciar a un usuario',
    other: 'Otra cosa',
  },
};
export default help;
