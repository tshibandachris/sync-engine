# POS multidevise — contrat serveur

Statut : décisions métier validées le 10 novembre 2026.

## Décisions validées
1. Un produit possède un seul prix, dans une seule devise : CDF ou USD.
2. Les montants sont des entiers : francs entiers pour CDF, centimes entiers pour USD.
3. Un panier mixte conserve deux sous-totaux indépendants. Aucun total global converti ne constitue la dette comptable.
4. Le taux journalier est saisi en CDF pour 1 USD. Chaque vente conserve un instantané immuable du taux et de sa date.
5. Les paiements peuvent être en espèces CDF, espèces USD ou Mobile Money. La monnaie rendue peut être dans une autre devise. Chaque mouvement est distinct.
6. La clôture rapproche séparément les espèces CDF et USD. Mobile Money est rapproché séparément.
7. Les calculs utilisent une arithmétique entière exacte, jamais de flottants IEEE-754.
8. L'arrondi est commercial half-up : au franc CDF ou au centime USD le plus proche. Aucun arrondi prématuré des calculs intermédiaires.
9. Une vente miroir void conserve exactement le taux et les montants de la vente originale.

## Représentation canonique
- CDF : entier de francs.
- USD : entier de centimes.
- rate_cdf_per_usd : entier strictement positif, francs CDF pour 1 USD.
- Chaque ligne de vente copie le nom, SKU, devise, prix unitaire et sous-total au moment de la vente.
- Le serveur recalcule les sous-totaux à partir des lignes reçues.

## Conversion exacte
Pour r = CDF par USD :
- USD-centimes vers CDF-francs : roundHalfUp(usdCents * r / 100).
- CDF-francs vers USD-centimes : roundHalfUp(cdfFrancs * 100 / r).
- Les demi-unités sont arrondies à l'écart de zéro. Les opérations intermédiaires utilisent BigInt.

Exemples à r = 2850 :
- 10 000 CDF -> 351 centimes USD.
- 125 centimes USD -> 3 563 CDF.
- 1 centime USD -> 29 CDF.
- 1 CDF -> 0 centime USD.

## Invariants serveur à couvrir avant activation
- Le serveur recalcule les deux sous-totaux et rejette toute incohérence.
- Un changement du taux journalier ne modifie aucune vente antérieure.
- Un void référence une vente originale, copie son taux et inverse chaque ligne/devise.
- Encaissements et restitutions sont des écritures distinctes et append-only.
- Les allocations d'un paiement vers les deux sous-totaux sont explicites et vérifiables; aucune allocation implicite.
- Une clôture hors ligne déclare sa couverture et reste pending jusqu'à réception de toutes les ventes couvertes.
- Les montants comptés sont immuables; les corrections sont des ajustements séparés.
- La clôture rapproche CDF et USD séparément. Mobile Money est rapproché séparément.
- Toutes les tables sont tenant-scoped, soumises à RLS et testées sous le rôle applicatif.

## Première tranche
Le module src/pos/money.ts fournit les primitives exactes et les tests unitaires de référence. Le schéma PostgreSQL, les contrats de paiement, les services et les routes seront livrés dans une migration et une PR dédiées après clôture de la PR #93. Aucun client Android/Electron ne doit réimplémenter les conversions.
