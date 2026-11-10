# Fog Explorer

Compagnon web pour [Fog of World](https://fogofworld.app) : il lit tes traces et montre les rues que tu n'as pas encore parcourues, avec le pourcentage de rues explorées par commune (Île-de-France). Il calcule aussi des itinéraires à pied (A → B ou boucle) qui passent par le plus de rues nouvelles possible.

## Fonctions

- **Commune** : rues faites ou à découvrir, pourcentage, liste des rues à finir.
- **Ma conquête de l'Île-de-France** : chaque commune est classée selon le % de km de rues faites : vierge, traversée (moins de 10 %), visitée (10 à 25 %), explorée (25 à 50 %), conquise (50 à 90 %), finie (au moins 90 %).

## Méthode de calcul

Fog of World mesure une surface dévoilée. Cette surface inclut les immeubles et les zones interdites, donc une ville parcourue à fond reste à quelques %. Ici, on compte plutôt les **km de rues accessibles à pied** (OpenStreetMap). Les autoroutes, les voies rapides, l'accès privé, les parkings et les voies de service sans nom sont exclus. Les trottoirs dessinés à part ne sont pas comptés, pour ne pas compter deux fois la même rue.

- Chaque tronçon est testé tous les 8 m. Un point compte s'il est près d'une trace : environ 12 m pour une rue, 18 à 25 m pour un boulevard, selon sa largeur.
- Si au moins 60 % des points d'un tronçon comptent, tout le tronçon est fait. Entre 25 et 60 %, il est compté au prorata. En dessous de 25 %, rien n'est compté : c'est souvent une simple traversée au carrefour.
- Une rue (toutes les voies du même nom) est **finie** quand au moins 90 % de sa longueur est faite.
- Les chemins des parcs, les sentiers et les escaliers ont leur propre %.
- **Itinéraires** :
  - de A à B (direct, équilibré, aventure) ;
  - boucle autour d'un point ;
  - **cocher une commune** : on part d'une gare ou de sa position, on ramasse le plus de rues nouvelles de la commune, puis on finit à une gare ou on revient au départ.
- Option « charme » : petites rues, passages et escaliers privilégiés, grands axes évités.
- Export GPX et Google Maps. Synchro Dropbox automatique.

## Confidentialité

- **Ce dépôt ne contient aucune donnée personnelle.** Seulement du code.
- Tes traces sont décodées et analysées **dans ton navigateur**. Elles restent dans le stockage local de l'appareil (IndexedDB) et ne sont envoyées à aucun serveur.
- Les rues, les gares et les **limites des communes** sont publiées avec l'appli (construites une fois par mois par `tools/`, à partir d'OpenStreetMap et de geo.api.gouv.fr) puis **gardées sur le téléphone**. Ouvrir une commune, en chercher une par son nom ou trouver celle où tu es ne demande rien à aucun serveur.
- Services tiers appelés, sans tes traces :
  - Esri (gris clair) ou OpenStreetMap France : le fond de carte ;
  - Géoplateforme IGN : la recherche d'adresse ;
  - Overpass et geo.api.gouv.fr : seulement en secours, si les données publiées avec l'appli sont absentes.
- Le bouton « Ma position » place un point sur la carte. La position reste dans l'appareil et le GPS s'arrête quand l'appli passe en arrière-plan.
- La synchro Dropbox est en lecture seule (OAuth PKCE, sans serveur ni secret). Le jeton reste dans ton navigateur.
- Aucun traceur, aucun cookie, aucune police ou script externe. Leaflet et JSZip sont inclus dans `vendor/`.
- Le bouton « Effacer toutes mes données » vide tout le stockage local et révoque le jeton Dropbox.

## Fluidité

- Tous les calculs lourds (croisement des rues et des traces, pourcentages, itinéraires, plus grand réseau) tournent dans un *worker* (`js/worker.js`) : la carte ne se fige plus pendant un calcul.
- L'appli s'ouvre depuis son cache sans attendre le réseau. Une nouvelle version se télécharge en arrière-plan, puis l'appli propose de recharger.
- Les rues d'une commune sont dessinées en trois tracés au lieu d'un par tronçon, et la carte des 1 300 communes en une forme par couleur.
- Sur téléphone, le panneau se tire à trois hauteurs (réduit, moitié, plein écran). Réduit, il laisse toute la carte et garde le résumé en une ligne.

## Format Fog of World

Ce sont des tuiles zlib. La grille fait 512×512 tuiles de 128×128 blocs, et chaque bloc est un bitmap de 64×64 pixels, soit environ 6 m par pixel à Paris. Voir `js/fog.js`. Le format a été documenté par le projet [Fog Machine](https://github.com/CaviarChen/fog-machine).
