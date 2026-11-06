# Fog Explorer

Compagnon web pour [Fog of World](https://fogofworld.app) : il lit tes traces et montre les rues que tu n'as pas encore parcourues, avec le pourcentage de rues explorées par commune (Île-de-France). Il calcule aussi des itinéraires à pied (A → B ou boucle) qui passent par le plus de rues nouvelles possible.

## Fonctions

- **Commune** : rues faites ou à découvrir, pourcentage, liste des rues à finir.
- **Ma conquête de l'Île-de-France** : chaque commune est classée vierge, traversée, visitée (5 à 50 % des rues) ou conquise (au moins 50 %).
- **Itinéraires** :
  - de A à B (direct, équilibré, aventure) ;
  - boucle autour d'un point ;
  - **cocher une commune** : on part d'une gare ou de sa position, on ramasse le plus de rues nouvelles de la commune, puis on finit à une gare ou on revient au départ.
- Option « charme » : petites rues, passages et escaliers privilégiés, grands axes évités.
- Export GPX et Google Maps. Synchro Dropbox automatique.

## Confidentialité

- **Ce dépôt ne contient aucune donnée personnelle.** Seulement du code.
- Tes traces sont décodées et analysées **dans ton navigateur**. Elles restent dans le stockage local de l'appareil (IndexedDB) et ne sont envoyées à aucun serveur.
- Services tiers appelés, sans tes traces :
  - OpenStreetMap / Overpass : la zone affichée, pour récupérer les rues ;
  - CARTO : le fond de carte ;
  - geo.api.gouv.fr : les limites des communes ;
  - Géoplateforme IGN : la recherche d'adresse.
- La synchro Dropbox est en lecture seule (OAuth PKCE, sans serveur ni secret). Le jeton reste dans ton navigateur.
- Aucun traceur, aucun cookie, aucune police ou script externe. Leaflet et JSZip sont inclus dans `vendor/`.
- Le bouton « Effacer toutes mes données » vide tout le stockage local et révoque le jeton Dropbox.

## Format Fog of World

Ce sont des tuiles zlib. La grille fait 512×512 tuiles de 128×128 blocs, et chaque bloc est un bitmap de 64×64 pixels, soit environ 6 m par pixel à Paris. Voir `js/fog.js`. Le format a été documenté par le projet [Fog Machine](https://github.com/CaviarChen/fog-machine).
