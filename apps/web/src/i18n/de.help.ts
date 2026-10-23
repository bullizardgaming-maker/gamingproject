import type { HelpPack } from './index';

const help: HelpPack = {
  topics: {
    buying: { title: 'Kaufen', blurb: 'Angebote finden, bestellen und Gekauftes erhalten.' },
    protection: { title: 'Streitfälle & Schutz', blurb: 'Käuferschutz, Treuhand, Versicherung und Erstattungen.' },
    payments: { title: 'Zahlungen', blurb: 'Krypto, Netzwerkgebühren, deine Wallet und Erstattungen.' },
    selling: { title: 'Verkaufen', blurb: 'Angebote, Lieferung, Gebühren und Auszahlungen.' },
    account: { title: 'Konto & Sicherheit', blurb: 'Verifizierung, Zwei-Faktor-Anmeldung und deine Daten.' },
  },
  articles: {
    'how-escrow-works': {
      title: "Wie Treuhand deine Bestellung schützt",
      summary: "Deine Zahlung bleibt bei uns, bis du bestätigst, dass du hast, wofür du bezahlt hast.",
      body: [
        "Wenn du bezahlst, geht das Geld in die Treuhand, nicht an den Verkäufer. Der Verkäufer sieht nur, dass die Bestellung bezahlt ist, und kann liefern.",
        "Es gibt keinen Timer: Das Geld bleibt in der Treuhand, bis du den Erhalt bestätigst. Bestätige erst, wenn du alles hast.",
        "Wenn etwas nicht stimmt, eröffne statt zu bestätigen einen Streitfall auf der Bestellseite. Das Geld bleibt gesperrt, bis er geklärt ist.",
      ],
    },
    'order-not-delivered': {
      title: 'Meine Bestellung wurde nicht geliefert',
      summary: 'Was du tun kannst, wenn ein Verkäufer zu spät ist, und wann du automatisch dein Geld zurückbekommst.',
      body: [
        'Angebote mit Sofortlieferung werden geliefert, sobald die Zahlung durch ist; sieh auf der Bestellseite nach. Bei manuellen Angeboten verspricht der Verkäufer eine Lieferzeit, die im Angebot steht.',
        'Schreib dem Verkäufer zuerst im Bestell-Chat; die meisten Verzögerungen klären sich dort. Ist die zugesagte Zeit vorbei, erinnern wir den Verkäufer, und liefert er dann immer noch nicht, wird die Bestellung storniert und automatisch erstattet.',
        'Du kannst auch jederzeit einen Streitfall auf der Bestellseite eröffnen, solange die Zahlung in der Treuhand ist.',
      ],
    },
    'open-a-dispute': {
      title: "Einen Streitfall eröffnen",
      summary: "Wenn etwas nicht wie beschrieben ist, entscheidet ein Schiedsrichter anhand von Chat und Belegen.",
      body: [
        "Eröffne den Streitfall auf der Bestellseite, bevor du die Bestellung bestätigst. Erkläre das Problem und füge Screenshots im Bestell-Chat hinzu.",
        "Die Zahlung bleibt gesperrt, während ein Bullizard-Schiedsrichter Chat, Lieferbelege und Beweise beider Seiten prüft.",
        "- Entscheidet er für dich, wird der volle Betrag deinem Bullizard-Guthaben gutgeschrieben.\n- Entscheidet er für den Verkäufer, wird die Zahlung an ihn freigegeben.",
      ],
    },
    'account-insurance': {
      title: 'Account-Versicherung und Inhabernachweis',
      summary: 'Warum Account-Angebote 14 Tage versichert sind und was „Inhaber verifiziert“ bedeutet.',
      body: [
        'Ein Vorbesitzer kann einen Account zurückholen, deshalb sind Account-Bestellungen 14 Tage nach Lieferung versichert: Wird der Account in dieser Zeit zurückgeholt, bekommst du dein Geld zurück.',
        'Angebote mit „Inhaber verifiziert“ stammen vom Erstbesitzer, der uns die Registrierungs-E-Mail und frühe Kaufbelege gezeigt hat. Angebote ohne Nachweis gelten als riskant; Treuhand und Versicherung gelten trotzdem.',
        'Ändere nach der Übergabe sofort E-Mail, Passwort und Zwei-Faktor-Einstellungen.',
      ],
    },
    'game-fields-and-filters': {
      title: 'Nach Server, Region, Plattform und Rang filtern',
      summary: 'Nutze die Auswahlfelder auf jeder Spieleseite, um nur passende Angebote zu sehen.',
      body: [
        'Viele Spiele teilen ihren Markt auf: League of Legends nach Server, Valorant nach Region, World of Warcraft nach Realm und Fraktion, CS2-Skins nach Zustand. Öffne ein Spiel, wähle eine Kategorie und nutze die Auswahlfelder über der Angebotstabelle.',
        'Jede Option zeigt, wie viele aktive Angebote sie mit deinen übrigen Filtern hat. Verkäufer müssen diese Felder ausfüllen, deshalb sind die Filter verlässlich.',
      ],
    },
    'price-alerts': {
      title: 'Merkliste und Preisalarme',
      summary: 'Beobachte ein Angebot oder einen ganzen Markt und erfahre von jedem neuen Tiefstpreis.',
      body: [
        'Nutze „Preisalarm“ bei einem Angebot oder „Bei neuen Tiefstpreisen benachrichtigen“ auf einer Spieleseite (deine Server- oder Regionsfilter bleiben erhalten). Du kannst einen Zielpreis setzen oder das Feld leer lassen, um bei jeder Senkung informiert zu werden.',
        'Wir prüfen alle paar Minuten und melden jeden neuen Tiefstpreis einmal, außerdem wenn ein ausverkauftes Angebot wieder verfügbar ist. Alles verwaltest du in deiner Merkliste.',
      ],
    },
    'payment-methods': {
      title: "Zahlungswege",
      summary: "Zahle in Krypto: Wähle einen gängigen Coin; seine Netzwerkgebühr kommt zum Gesamtbetrag dazu.",
      body: [
        "Bezahlt wird in Krypto. Wähle einen Coin aus der Liste; jeder zeigt sein Netzwerk (z. B. TRC-20) und den Gesamtbetrag.",
        "Die Netzwerkgebühr kommt obendrauf: Eine Bestellung über 11,50 $ mit 1,00 $ Gebühr heißt, du sendest 12,50 $. Nur der Bestellbetrag geht an den Verkäufer.",
        "Sende genau den Betrag an die angezeigte Adresse im selben Netzwerk. Die Bestellung ist bezahlt, sobald das Netzwerk bestätigt. Coins mit einem Minimum über deiner Bestellung sind ausgegraut.",
        "Dein Bullizard-Guthaben wird zuerst verwendet.",
      ],
    },
    'refund-timing': {
      title: "Wann sehe ich meine Erstattung?",
      summary: "Erstattungen landen sofort in deinem Bullizard-Guthaben.",
      body: [
        "Wird eine Bestellung erstattet, geht das Geld sofort auf dein Bullizard-Guthaben. Du siehst es auf deiner Wallet-Seite.",
        "Nutze es für die nächste Bestellung oder zahle es auf deine Krypto-Wallet aus (USDT TRC-20). Es fällt eine Auszahlungsgebühr an; die Treasury sendet nach Freigabe.",
      ],
    },
    'selling-fees': {
      title: 'Verkäuferprovision und Ränge',
      summary: 'Du legst deinen Preis fest und erhältst ihn vollständig; die Provision kommt für den Käufer obendrauf und sinkt mit deinem Rang.',
      body: [
        'Du gibst den Preis ein, den du willst. Die Provision deines Rangs wird für den Käufer aufgeschlagen, sodass genau dein Betrag auf deinem Guthaben landet, wenn die Bestellung abgeschlossen ist. Ränge richten sich nach deinen abgeschlossenen Verkäufen der letzten 30 Tage; neue Verkäufer zahlen in den ersten 60 Tagen einen reduzierten Startsatz.',
        'Das Verkaufsformular zeigt vor dem Veröffentlichen, was Käufer in jeder Währung zahlen und was dir nach der Auszahlungsgebühr bleibt. Rang und Fortschritt siehst du im Verkäuferbereich.',
      ],
    },
    'delivery-in-game': {
      title: 'So funktioniert die Lieferung im Spiel',
      summary: 'Währung und Items werden an den Charakternamen gehandelt, den du beim Bezahlen bestätigst; der Verkäufer hängt einen Nachweis an und du gibst die Zahlung frei.',
      body: [
        'Bei Spielen mit Lieferung im Spiel (Währung, Items, Aufladungen) nennst du den genauen Charakternamen oder die UID, mit der der Verkäufer handeln soll. Beim Bezahlen bestätigst du sie mit einem Tipp, und sie wird für die nächste Bestellung gemerkt. Prüfe sie sorgfältig: Der Verkäufer liefert an diesen Namen, und du bist dafür verantwortlich, dass er stimmt.',
        'Der Verkäufer handelt mit diesem Charakter und hängt ein Foto oder Video des Handels an, bevor er die Bestellung als geliefert markiert. Den Nachweis siehst du auf der Bestellseite.',
        'Die Zahlung bleibt im Treuhandkonto, bis du den Erhalt bestätigst. Stimmt etwas nicht, eröffne auf der Bestellseite einen Streitfall statt zu bestätigen; das Team vergleicht den Nachweis mit dem Handel und entscheidet.',
      ],
    },
    'getting-paid': {
      title: 'Auszahlungen erhalten',
      summary: 'Zahle nach der Bestätigung des Käufers auf dein Krypto-Wallet (USDT) aus; es gilt eine Gebühr von 6 %.',
      body: [
        'Geld aus einem Verkauf wird verfügbar, wenn der Käufer die Bestellung bestätigt. Zahle es im Verkäuferbereich an die per E-Mail bestätigte Auszahlungsadresse aus; die Treasury gibt es frei und sendet es in USDT.',
        'Neue Verkäufer können eine kurze Auszahlungssperre haben, bis Vertrauen aufgebaut ist; der Verkäuferbereich zeigt, wann gesperrtes Geld frei wird.',
        'Bringt eine Erstattung oder Rückbuchung dein Guthaben unter null, gleichen neue Verkäufe es zuerst aus und Auszahlungen pausieren bis dahin.',
      ],
    },
    'seller-analytics': {
      title: 'Deine Shop-Statistiken verstehen',
      summary: 'Aufrufe, Konversion und Stammkunden – und wie sie gezählt werden.',
      body: [
        'Der Tab „Statistiken“ zeigt Umsatz, Angebotsaufrufe, Konversion (Bestellungen geteilt durch Aufrufe), durchschnittlichen Bestellwert und Stammkunden im Vergleich zum Vorzeitraum.',
        'Ein Aufruf zählt einmal pro Besucher, Angebot und Stunde – nie, wenn du dein eigenes Angebot ansiehst.',
      ],
    },
    'verify-identity': {
      title: 'Deine Identität bestätigen',
      summary: 'Stufe 1 zum Kaufen, Stufe 2 (Ausweis mit Foto) zum Verkaufen.',
      body: [
        'Stufe 1 bedeutet bestätigte E-Mail und Telefonnummer; das reicht zum Kaufen. Stufe 2 ergänzt einen Ausweis mit Foto und einen Lebendigkeitstest über unseren Verifizierungspartner und ist zum Verkaufen nötig.',
        'Die Verifizierung dauert meist ein paar Minuten. Schlägt sie fehl, prüfe, ob das Foto scharf ist und alle Ecken des Dokuments sichtbar sind, und versuche es erneut.',
      ],
    },
    'two-factor': {
      title: 'Zwei-Faktor-Anmeldung und Sicherheit',
      summary: 'Aktiviere eine Authenticator-App und teile niemals Codes im Bestell-Chat.',
      body: [
        'Aktiviere die Zwei-Faktor-Anmeldung unter Konto → Sicherheit mit einer beliebigen Authenticator-App und bewahre deine Wiederherstellungscodes sicher auf.',
        'Das Bullizard-Team fragt nie nach deinem Passwort oder einem Anmeldecode. Bleib mit Deals im Bestell-Chat: In andere Apps verlagerte Deals sind nicht durch die Treuhand geschützt.',
      ],
    },
    'report-a-user': {
      title: 'Betrugsversuche oder Missbrauch melden',
      summary: 'Melde uns Zahlungsaufforderungen außerhalb der Plattform, Phishing-Links oder Belästigung.',
      body: [
        'Fordert dich jemand auf, außerhalb von Bullizard zu zahlen, schickt einen verdächtigen Link oder wird ausfallend, antworte nicht weiter. Schick uns eine Anfrage in der Kategorie „Nutzer melden“ mit dem Namen und der Bestellung oder dem Chat, in dem es passiert ist.',
        'Unser Trust-&-Safety-Team prüft jede Meldung. Das Ergebnis können wir dir nicht immer mitteilen, aber wir handeln.',
      ],
    },
    'buyer-protection': {
      title: "Bullizard Käuferschutz",
      summary: "Dein Geld geht erst an den Verkäufer, wenn du den Erhalt bestätigst.",
      body: [
        "Wenn du bezahlst, hält Bullizard das Geld. Der Verkäufer sieht, dass die Bestellung bezahlt ist, und liefert.",
        "Der Verkäufer wird erst bezahlt, wenn du den Erhalt bestätigst. Du kannst bestätigen, sobald du die Ware hast, auch bevor der Verkäufer sie als geliefert markiert.",
        "- Nicht in der versprochenen Zeit geliefert: Die Bestellung wird storniert und du bekommst dein Geld zurück.\n- Nicht wie beschrieben: Eröffne vor dem Bestätigen einen Streitfall auf der Bestellseite. Das Geld bleibt gesperrt, bis ein Bullizard-Schiedsrichter entscheidet.\n- Spielkonten: 14 Tage Versicherung nach der Lieferung.",
        "Wickle den ganzen Handel im Bestell-Chat ab. Deals außerhalb von Bullizard sind nicht geschützt.",
      ],
    },
    'wallet': {
      title: "Deine Wallet",
      summary: "Dein Guthaben und jede Geldbewegung in einer Liste.",
      body: [
        "Öffne die Wallet über das Kontomenü. Oben steht dein Guthaben, darunter jede Bestellung, Erstattung, jeder Verkauf und jede Auszahlung.",
        "- Gelb, Gehalten: Das Geld ist in der Treuhand, bis die Bestellung bestätigt ist.\n- Grün, Abgeschlossen: erledigt.\n- Rot, Storniert: Bestellung oder Auszahlung wurde storniert.\n- Grau, Ausstehend: wartet auf Zahlung oder Freigabe.",
        "Verkäufer sehen ihre Verkäufe in derselben Liste. Auszahlungen und Steuerdokumente findest du im Verkäuferbereich unter Geld.",
      ],
    },
    'sell-by-amount': {
      title: "Währung nach Menge verkaufen",
      summary: "Lege Einheit, Preis pro Einheit, Minimum und Bestand fest; Käufer wählen die Menge.",
      body: [
        "Wähle im Verkaufsformular Währung und gib die Einheit an, z. B. M für Millionen Silber. Der Preis gilt dann pro Einheit.",
        "Lege Bestand und Mindestbestellung fest, beides in Einheiten. Käufer wählen eine Menge zwischen deinem Minimum und deinem Bestand; der Gesamtbetrag passt sich an.",
        "Auf der Spielseite erscheint dein Angebot in der Verkäufertabelle mit Server, Bestand, Minimum, Lieferzeit und Preis pro Einheit.",
      ],
    },
    'seller-badges': {
      title: "Deine Abzeichen und dein Shop",
      summary: "Wähle die 2 Abzeichen, die Käufer neben deinem Namen sehen.",
      body: [
        "Du verdienst Abzeichen beim Verkaufen: deinen Rang, Gründungsverkäufer, ID verifiziert und Top-Verkäufer. Wähle im Verkäuferbereich unter deinem Shop bis zu 2, die neben deinem Namen bei Angeboten erscheinen.",
        "Dein Shop zeigt außerdem deine Sprachen, deine Vorstellung und deine Zahlen: positive Bewertungen, Bewertung, verkaufte Bestellungen und pünktliche Lieferung.",
      ],
    },
  },
  ticketCategories: {
    order: 'Ein Problem mit einer Bestellung',
    payment: 'Zahlungen und Erstattungen',
    account: 'Mein Konto oder die Verifizierung',
    selling: 'Verkaufen und Auszahlungen',
    report: 'Nutzer melden',
    other: 'Etwas anderes',
  },
};
export default help;
