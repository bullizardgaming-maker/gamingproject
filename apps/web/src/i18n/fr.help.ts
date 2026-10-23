import type { HelpPack } from './index';

const help: HelpPack = {
  topics: {
    buying: { title: 'Acheter', blurb: 'Trouver des offres, commander et recevoir vos achats.' },
    protection: { title: 'Litiges et protection', blurb: 'Protection acheteur, séquestre, assurance et remboursements.' },
    payments: { title: 'Paiements', blurb: 'Crypto, frais de réseau, votre portefeuille et remboursements.' },
    selling: { title: 'Vendre', blurb: 'Offres, livraison, frais et versements.' },
    account: { title: 'Compte et sécurité', blurb: 'Vérification, double authentification et vos données.' },
  },
  articles: {
    'open-a-dispute': {
      title: "Ouvrir un litige",
      summary: "Si ce n’est pas conforme, un arbitre décide à partir du chat et des preuves.",
      body: [
        "Ouvrez un litige depuis la page de la commande avant de la confirmer. Expliquez le problème et ajoutez des captures dans le chat.",
        "Le paiement reste bloqué pendant qu’un arbitre Bullizard examine le chat, les preuves de livraison et les éléments des deux parties.",
        "- Si l’arbitre vous donne raison, le montant total est remboursé sur votre solde Bullizard.\n- S’il donne raison au vendeur, le paiement lui est versé.",
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
    'price-alerts': {
      title: 'Liste de suivi et alertes prix',
      summary: 'Suivez une offre ou tout un marché et soyez prévenu à chaque nouveau prix bas.',
      body: [
        'Utilisez « Alerte prix » sur une offre, ou « M’alerter des nouveaux prix bas » sur la page d’un jeu (vos filtres de serveur ou de région sont conservés). Fixez un prix cible, ou laissez vide pour être prévenu de toute baisse.',
        'Nous vérifions toutes les quelques minutes et vous prévenons une fois par nouveau prix bas, ainsi qu’au retour en stock d’une offre épuisée. Gérez tout depuis votre liste de suivi.',
      ],
    },
    'payment-methods': {
      title: "Moyens de paiement",
      summary: "Payez en crypto : choisissez une crypto courante ; ses frais de réseau s’ajoutent au total.",
      body: [
        "Le paiement se fait en crypto. Choisissez une crypto dans la liste ; chacune affiche son réseau (par ex. TRC-20) et le total à envoyer.",
        "Les frais de réseau s’ajoutent : une commande de 11,50 $ avec 1,00 $ de frais signifie que vous envoyez 12,50 $. Seul le montant de la commande va au vendeur.",
        "Envoyez le montant exact à l’adresse indiquée, sur le même réseau. La commande est payée dès que le réseau confirme. Les cryptos dont le minimum dépasse votre commande sont grisées.",
        "Votre solde Bullizard est utilisé en premier.",
      ],
    },
    'delivery-in-game': {
      title: 'Comment fonctionne la livraison en jeu',
      summary: 'La monnaie et les objets sont échangés au nom de personnage que vous confirmez au paiement ; le vendeur joint une preuve et vous libérez le paiement.',
      body: [
        'Pour les jeux livrés en jeu (monnaie, objets, recharges), vous indiquez le nom de personnage ou l’UID exact avec lequel le vendeur doit échanger. Vous le confirmez d’un geste au paiement et il est mémorisé pour la commande suivante ; vérifiez-le bien, car le vendeur livre à ce nom et vous êtes responsable de son exactitude.',
        'Le vendeur échange avec ce personnage et joint une photo ou une vidéo de l’échange avant de marquer la commande comme livrée. La preuve est visible sur la page de la commande.',
        'Le paiement reste sous séquestre jusqu’à ce que vous confirmiez la réception. En cas de problème, ouvrez un litige depuis la page de la commande au lieu de confirmer ; l’équipe compare la preuve à l’échange et tranche.',
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
    'wallet': {
      title: "Votre portefeuille",
      summary: "Votre solde et chaque mouvement d’argent dans une seule liste.",
      body: [
        "Ouvrez Portefeuille depuis le menu du compte. En haut, votre solde ; en dessous, chaque commande, remboursement, vente et retrait.",
        "- Jaune, Bloqué : l’argent est en séquestre jusqu’à la confirmation.\n- Vert, Terminé : c’est réglé.\n- Rouge, Annulé : la commande ou le retrait a été annulé.\n- Gris, En attente : paiement ou validation en attente.",
        "Les vendeurs voient leurs ventes dans la même liste. Paiements et documents fiscaux sont dans l’espace vendeur, rubrique Argent.",
      ],
    },
    'sell-by-amount': {
      title: "Vendre de la monnaie à la quantité",
      summary: "Fixez une unité, un prix par unité, un minimum et votre stock ; l’acheteur choisit la quantité.",
      body: [
        "Dans le formulaire de vente, choisissez Monnaie et indiquez l’unité, par ex. M pour millions d’argent. Le prix est alors par unité.",
        "Indiquez votre stock et la commande minimum, en unités. L’acheteur choisit une quantité entre votre minimum et votre stock, et le total se met à jour.",
        "Sur la page du jeu, votre offre apparaît dans le tableau des vendeurs avec serveur, stock, minimum, délai de livraison et prix par unité.",
      ],
    },
    'seller-badges': {
      title: "Vos badges et votre boutique",
      summary: "Choisissez les 2 badges que les acheteurs voient à côté de votre nom.",
      body: [
        "Vous gagnez des badges en vendant : votre rang, Vendeur fondateur, ID vérifiée et Top vendeur. Dans l’espace vendeur, sous votre boutique, choisissez-en 2 au plus à afficher à côté de votre nom.",
        "Votre boutique affiche aussi vos langues, votre présentation et vos statistiques : avis positifs, note, commandes vendues et livraisons à temps.",
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
