# Lift pixel-art assets

These PNGs are native-size sprite sheets for the lift simulation. Keep image smoothing disabled when drawing them so the pixel clusters stay crisp.

## Frame order

| File | Native size | Frames, left to right |
| --- | ---: | --- |
| `ground-street.png` | 48x16 | tile |
| `ground-entrance.png` | 96x16 | day, night |
| `earth-fill.png` | 48x32 | tile |
| `earth-edge.png` | 48x32 | tile |
| `basement-empty.png` | 48x32 | tile |
| `basement-parking.png` | 144x32 | empty, one car, two cars |
| `basement-storage.png` | 48x32 | tile |
| `basement-utility.png` | 96x32 | idle, active |
| `foundation-slab.png` | 48x6 | tile |
| `palette-icons.png` | 544x32 | office, condo, shop, hotel, lobby, parking, storage, utility, elevator, express elevator, stairs, escalator, demolish, bulldozer, inspect, repair, finances |
| `office.png` | 240x32 | vacant, occupied day A, occupied day B, occupied night, stressed |
| `condo.png` | 240x32 | vacant, occupied day A, occupied day B, occupied night, stressed |
| `shop.png` | 240x32 | vacant, open grocery, open cafe, open awning, closed night |
| `hotel.png` | 192x32 | vacant, booked day, booked night, poor review |
| `slot-empty.png` | 192x32 | empty, selected, unavailable, highlighted |
| `slot-construction.png` | 144x32 | planned, building, complete |
| `lobby.png` | 96x32 | day, night |
| `lobby-wing.png` | 96x32 | day, night |
| `floor-slab.png` | 48x4 | tile |
| `roof-cap.png` | 96x12 | plain, antenna |
| `shaft-column.png` | 48x32 | tile |
| `elevator-car.png` | 120x26 | closed, opening, open |
| `elevator-car-express.png` | 120x26 | closed, opening, open |
| `stairs-segment.png` | 48x32 | tile |
| `escalator-segment.png` | 192x32 | animation frame 1, 2, 3, 4 |
| `person-worker.png` | 128x16 | walk left 1, walk left 2, walk right 1, walk right 2, stand, fidget, wait, tired wait |
| `person-resident.png` | 144x16 | walk left 1, walk left 2, walk right 1, walk right 2, stand, fidget, wait, impatient wait, shopping bag |
| `person-guest.png` | 144x16 | walk left 1, walk left 2, walk right 1, walk right 2, stand, fidget, wait, impatient wait, suitcase |

The visual palette follows the asset brief: background `#0e1116`, panel `#1b2430`, good `#3ddc97`, warning `#ffb703`, bad `#ef476f`, info `#8ecae6`, and hotel violet `#c77dff`.
