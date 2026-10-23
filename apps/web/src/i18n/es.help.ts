import type { HelpPack } from './index';

const help: HelpPack = {
  topics: {
    buying: { title: 'Comprar', blurb: 'Encontrar ofertas, pedir y recibir lo que compraste.' },
    protection: { title: 'Disputas y protección', blurb: 'Protección al comprador, depósito, seguro y reembolsos.' },
    payments: { title: 'Pagos', blurb: 'Cripto, comisiones de red, tu cartera y reembolsos.' },
    selling: { title: 'Vender', blurb: 'Ofertas, entregas, comisiones y cobros.' },
    account: { title: 'Cuenta y seguridad', blurb: 'Verificación, inicio de sesión en dos pasos y tus datos.' },
  },
  articles: {
    'open-a-dispute': {
      title: "Abrir una disputa",
      summary: "Si algo no es lo descrito, un árbitro decide con el chat del pedido y las pruebas.",
      body: [
        "Abre una disputa desde la página del pedido antes de confirmarlo. Explica qué falla y añade capturas al chat del pedido.",
        "El pago queda congelado mientras un árbitro de Bullizard revisa el chat, los registros de entrega y las pruebas de ambas partes.",
        "- Si el árbitro decide a tu favor, se te reembolsa el importe completo a tu saldo de Bullizard.\n- Si decide a favor del vendedor, se le libera el pago.",
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
    'price-alerts': {
      title: 'Lista de seguimiento y alertas de precio',
      summary: 'Sigue una oferta o un mercado entero y entérate de cada nuevo mínimo.',
      body: [
        'Usa «Alerta de precio» en una oferta o «Avísame de nuevos mínimos» en la página de un juego (mantiene tus filtros de servidor o región). Puedes fijar un precio objetivo o dejarlo vacío para enterarte de cualquier bajada.',
        'Revisamos cada pocos minutos y te avisamos una vez por cada nuevo mínimo, y cuando una oferta agotada vuelve a tener stock. Gestiónalo todo desde tu lista de seguimiento.',
      ],
    },
    'payment-methods': {
      title: "Formas de pago",
      summary: "Paga con cripto: elige una moneda popular; su comisión de red se suma al total.",
      body: [
        "El pago es con cripto. Elige una moneda de la lista; cada una muestra su red (por ejemplo TRC-20) y el total a enviar.",
        "La comisión de red de la moneda se suma: un pedido de $11.50 con $1.00 de comisión significa que envías $12.50. Al vendedor solo va el importe del pedido.",
        "Envía el importe exacto a la dirección indicada, en la misma red. El pedido queda pagado cuando la red lo confirma. Las monedas cuyo mínimo supera tu pedido aparecen en gris.",
        "Primero se usa el dinero de tu saldo de Bullizard.",
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
    'seller-analytics': {
      title: 'Leer las estadísticas de tu tienda',
      summary: 'Visitas, conversión y compradores recurrentes, y cómo se cuentan.',
      body: [
        'La pestaña Estadísticas muestra ventas, visitas a ofertas, conversión (pedidos entre visitas), pedido medio y compradores recurrentes, comparados con el periodo anterior.',
        'Una visita cuenta una vez por visitante, oferta y hora, y nunca cuando miras tu propia oferta.',
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
    'wallet': {
      title: "Tu cartera",
      summary: "Tu saldo y cada movimiento de dinero en una sola lista.",
      body: [
        "Abre Cartera desde el menú de la cuenta. Arriba ves tu saldo; debajo, cada pedido, reembolso, venta y retiro.",
        "- Amarillo, Retenido: el dinero está en depósito hasta que se confirme el pedido.\n- Verde, Completado: listo.\n- Rojo, Cancelado: se canceló el pedido o el retiro.\n- Gris, Pendiente: esperando el pago o la aprobación.",
        "Los vendedores ven sus ventas en la misma lista. Los pagos y documentos fiscales están en el panel de vendedor, en Dinero.",
      ],
    },
    'sell-by-amount': {
      title: "Vender moneda por cantidad",
      summary: "Define una unidad, un precio por unidad, un mínimo y tu stock; el comprador elige cuánto.",
      body: [
        "En el formulario de venta elige Moneda y escribe la unidad, por ejemplo M para millones de plata. El precio pasa a ser por unidad.",
        "Define tu stock y el pedido mínimo, ambos en unidades. El comprador elige cualquier cantidad entre tu mínimo y tu stock, y el total se actualiza.",
        "En la página del juego tu oferta aparece en la tabla de vendedores con servidor, stock, mínimo, tiempo de entrega y precio por unidad.",
      ],
    },
    'seller-badges': {
      title: "Tus insignias y tu tienda",
      summary: "Elige las 2 insignias que ven los compradores junto a tu nombre.",
      body: [
        "Ganas insignias al vender: tu rango, Vendedor fundador, ID verificado y Top vendedor. En el panel de vendedor, bajo tu tienda, elige hasta 2 para mostrar junto a tu nombre en las ofertas.",
        "Tu tienda también muestra los idiomas que hablas, tu presentación y tus estadísticas: reseñas positivas, valoración, pedidos vendidos y entregas a tiempo.",
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
