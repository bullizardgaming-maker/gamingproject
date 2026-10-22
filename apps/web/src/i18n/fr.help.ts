import type { HelpPack } from './index';

const help: HelpPack = {
  topics: {
    buying: { title: 'Acheter', blurb: 'Trouver des offres, commander et recevoir vos achats.' },
    protection: { title: 'Litiges et protection', blurb: 'Séquestre, délai d’inspection, assurance et remboursements.' },
    payments: { title: 'Paiements', blurb: 'Cartes, crypto, devises et crédit boutique.' },
    selling: { title: 'Vendre', blurb: 'Offres, livraison, frais et versements.' },
    account: { title: 'Compte et sécurité', blurb: 'Vérification, double authentification et vos données.' },
  },
  articles: {
    'how-escrow-works': {
      title: 'Comment le séquestre protège votre commande',
      summary: 'Votre paiement attend chez nous jusqu’à ce que vous ayez ce que vous avez payé.',
      body: [
        'Quand vous payez, l’argent va sous séquestre, pas au vendeur. Le vendeur voit seulement que la commande est payée et peut livrer.',
        'Après la livraison, vous disposez d’un délai de protection pour tout vérifier : 72 heures pour les clés, monnaies, objets, recharges et boosting, et 14 jours d’assurance pour les comptes de jeu.',
        'Le vendeur est payé quand vous confirmez la commande ou quand le délai expire sans litige, selon ce qui arrive en premier. En cas de problème, ouvrez un litige depuis la page de la commande avant la fin du délai : l’argent reste gelé jusqu’à la décision.',
      ],
    },
    'order-not-delivered': {
      title: 'Ma commande n’a pas été livrée',
      summary: 'Que faire quand un vendeur est en retard, et quand vous êtes remboursé automatiquement.',
      body: [
        'Les offres à livraison immédiate sont livrées dès la validation du paiement ; consultez la page de la commande. Pour les offres manuelles, le vendeur annonce un délai de livraison affiché sur l’offre.',
        'Écrivez d’abord au vendeur dans le chat de la commande ; la plupart des retards s’y règlent. Si le délai promis est dépassé, nous relançons le vendeur, et s’il ne livre toujours pas, la commande est annulée et remboursée automatiquement.',
        'Vous pouvez aussi ouvrir un litige depuis la page de la commande tant que le paiement est sous séquestre.',
      ],
    },
    'open-a-dispute': {
      title: 'Ouvrir un litige',
      summary: 'Si quelque chose ne correspond pas à la description, un arbitre tranche à partir du chat et des preuves.',
      body: [
        'Ouvrez un litige depuis la page de la commande pendant le délai de protection. Expliquez le problème et ajoutez des captures d’écran au chat de la commande.',
        'Le paiement reste gelé pendant qu’un arbitre Bullizard examine le chat, les traces de livraison et les preuves des deux parties.',
        '- Si l’arbitre vous donne raison, le montant total est remboursé sur votre moyen de paiement d’origine.\n- S’il donne raison au vendeur, le paiement lui est versé.',
      ],
    },
    'account-insurance': {
      title: 'Assurance des comptes et preuve de propriété',
      summary: 'Pourquoi les comptes sont assurés 14 jours et ce que signifie « propriétaire vérifié ».',
      body: [
        'Un ancien propriétaire peut récupérer un compte : les commandes de comptes sont donc assurées 14 jours après la livraison. Si le compte est repris pendant ce délai, vous êtes remboursé.',
        'Les offres « propriétaire vérifié » viennent du propriétaire d’origine, qui nous a montré l’e-mail d’inscription et les premiers reçus. Les autres sont signalées à risque élevé ; le séquestre et l’assurance s’appliquent toujours.',
        'Après la remise, changez immédiatement l’e-mail, le mot de passe et la double authentification.',
      ],
    },
    'game-fields-and-filters': {
      title: 'Filtrer par serveur, région, plateforme et rang',
      summary: 'Utilisez les sélecteurs de chaque jeu pour ne voir que les offres qui vous conviennent.',
      body: [
        'Beaucoup de jeux divisent leur marché : League of Legends par serveur, Valorant par région, World of Warcraft par royaume et faction, les skins CS2 par usure. Ouvrez un jeu, choisissez une catégorie et utilisez les sélecteurs au-dessus du tableau.',
        'Chaque option indique combien d’offres actives elle compte avec vos autres filtres. Les vendeurs doivent renseigner ces champs : les filtres sont fiables.',
      ],
    },
    'price-alerts': {
      title: 'Liste de suivi et alertes prix',
      summary: 'Suivez une offre ou tout un marché et soyez prévenu à chaque nouveau prix bas.',
      body: [
        'Utilisez « Alerte prix » sur une offre, ou « M’alerter des nouveaux prix bas » sur la page d’un jeu (vos filtres de serveur ou de région sont conservés). Fixez un prix cible, ou laissez vide pour être prévenu de toute baisse.',
        'Nous vérifions toutes les quelques minutes et vous prévenons une fois par nouveau prix bas, ainsi qu’au retour en stock d’une offre épuisée. Gérez tout depuis votre liste de suivi.',
      ],
    },
    'payment-methods': {
      title: 'Moyens de paiement',
      summary: 'Carte via une page de paiement sécurisée, ou USDC/USDT via un contrat de séquestre on-chain.',
      body: [
        'Les paiements par carte passent par la page sécurisée de notre partenaire ; nous ne voyons jamais votre numéro de carte. Vous payez le prix affiché, dans la devise de l’offre.',
        'Les paiements en crypto utilisent un contrat de séquestre on-chain avec le même délai de protection. Envoyez uniquement le montant exact à l’adresse du contrat indiquée pour votre commande.',
        'Les prix affichés dans une autre devise sont approximatifs ; la page de paiement montre toujours le montant exact débité.',
      ],
    },
    'refund-timing': {
      title: 'Quand vais-je recevoir mon remboursement ?',
      summary: 'Les remboursements reviennent sur le moyen de paiement d’origine ; les banques prennent quelques jours.',
      body: [
        'Les remboursements reviennent sur la carte ou le portefeuille utilisé. Nous envoyons les remboursements par carte immédiatement ; votre banque les affiche généralement sous 5 à 10 jours ouvrés.',
        'Le crédit boutique (promotions ou parrainages) est rendu en crédit boutique immédiatement.',
      ],
    },
    'selling-fees': {
      title: 'Frais et niveaux vendeur',
      summary: 'Les frais baissent avec vos ventes sur 30 jours ; cartes cadeaux, recharges et jeux vidéo ont un taux réduit.',
      body: [
        'Chaque vente paie une commission qui dépend de votre niveau, fixé par vos ventes des 30 derniers jours. Les comptes ont leur propre taux ; cartes cadeaux, recharges et jeux vidéo paient 4,99 %.',
        'Vous voyez les frais exacts et vos gains nets sur chaque commande, et votre niveau et votre progression dans l’espace vendeur.',
      ],
    },
    'getting-paid': {
      title: 'Être payé',
      summary: 'Retirez vers votre banque en USD, EUR ou GBP à la fin du délai de protection.',
      body: [
        'L’argent d’une vente est disponible quand l’acheteur confirme ou à la fin du délai de protection. Retirez-le depuis l’espace vendeur vers le compte bancaire ajouté sur la page de notre partenaire de paiement.',
        'Les nouveaux vendeurs peuvent avoir un court délai de versement le temps d’établir la confiance ; l’espace vendeur indique quand les fonds sont libérés.',
        'Si un remboursement ou une rétrofacturation rend votre solde négatif, les nouvelles ventes le comblent d’abord et les retraits sont suspendus jusqu’au règlement.',
      ],
    },
    'seller-analytics': {
      title: 'Lire les statistiques de votre boutique',
      summary: 'Vues, conversion et clients fidèles, et comment ils sont comptés.',
      body: [
        'L’onglet Statistiques montre les ventes, les vues des offres, la conversion (commandes divisées par vues), le panier moyen et les clients fidèles, comparés à la période précédente.',
        'Une vue compte une fois par visiteur, offre et heure, et jamais quand vous consultez votre propre offre.',
      ],
    },
    'verify-identity': {
      title: 'Vérifier votre identité',
      summary: 'Niveau 1 pour acheter, niveau 2 (pièce d’identité) pour vendre.',
      body: [
        'Le niveau 1 correspond à un e-mail et un téléphone vérifiés ; il suffit pour acheter. Le niveau 2 ajoute une pièce d’identité et une vérification du vivant via notre partenaire, et il est requis pour vendre.',
        'La vérification prend généralement quelques minutes. En cas d’échec, vérifiez que la photo est nette et que tous les coins du document sont visibles, puis réessayez.',
      ],
    },
    'two-factor': {
      title: 'Double authentification et sécurité',
      summary: 'Activez une application d’authentification et ne partagez jamais de codes dans le chat.',
      body: [
        'Activez la double authentification dans Compte → Sécurité avec n’importe quelle application d’authentification, et gardez vos codes de récupération en lieu sûr.',
        'L’équipe Bullizard ne vous demandera jamais votre mot de passe ni un code de connexion. Gardez les échanges dans le chat de la commande : les accords déplacés vers d’autres applis ne sont pas protégés par le séquestre.',
      ],
    },
    'report-a-user': {
      title: 'Signaler une tentative d’arnaque ou un abus',
      summary: 'Signalez-nous les demandes de paiement hors plateforme, les liens de phishing ou le harcèlement.',
      body: [
        'Si quelqu’un vous demande de payer en dehors de Bullizard, envoie un lien suspect ou se montre abusif, ne répondez plus. Envoyez-nous une demande dans la catégorie « Signaler un utilisateur » avec son nom et la commande ou le chat concerné.',
        'Notre équipe confiance et sécurité examine chaque signalement. Nous ne pouvons pas toujours vous communiquer l’issue, mais nous agissons.',
      ],
    },
  },
  ticketCategories: {
    order: 'Un problème avec une commande',
    payment: 'Paiements et remboursements',
    account: 'Mon compte ou la vérification',
    selling: 'Ventes et versements',
    report: 'Signaler un utilisateur',
    other: 'Autre chose',
  },
};
export default help;
