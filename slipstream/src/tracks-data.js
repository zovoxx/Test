// Track definitions.
//
// To add or edit a track, change the `points` array: each entry is
// [x, z, elevation] in metres. The points form a closed loop that is smoothed
// with a centripetal Catmull-Rom spline. Run `npm run check:tracks` to verify
// that corners are not too tight (min radius > ~25 m) and that different parts
// of the loop stay at least ~35 m apart (so walls never overlap).

import { roundedPolyline } from './track.js';

export const TRACKS = [
  {
    id: 'coastal',
    name: 'Coastal Loop',
    description: 'Sunny countryside sweepers along a quiet lake.',
    theme: 'coastal',
    timeOfDay: 13.5,
    music: 0,
    halfWidth: 7,
    runoff: 5.5,
    points: [
      [0, 0, 2],
      [130, 4, 2],
      [250, -10, 3],
      [330, -55, 4],
      [365, -140, 6],
      [340, -225, 8],
      [270, -268, 8],
      [190, -255, 6],
      [140, -205, 5],
      [80, -195, 4],
      [30, -240, 5],
      [-20, -310, 7],
      [-100, -345, 9],
      [-185, -325, 8],
      [-240, -260, 6],
      [-238, -190, 4],
      [-195, -150, 3],
      [-165, -105, 2],
      [-180, -55, 2],
      [-205, 10, 2],
      [-150, 52, 2],
      [-75, 38, 2],
    ],
  },
  {
    id: 'neon',
    name: 'Neon City',
    description: 'Rain-slick downtown blocks under neon lights.',
    theme: 'city',
    timeOfDay: 23,
    music: 1,
    halfWidth: 7.5,
    runoff: 4.5,
    points: roundedPolyline(
      [
        [0, 0, 0],
        [230, 0, 0],
        [230, -160, 4],
        [95, -160, 6],
        [95, -300, 3],
        [-115, -300, 0],
        [-115, -175, 0],
        [-235, -175, 0],
        [-235, 0, 0],
      ],
      36,
    ),
  },
  {
    id: 'canyon',
    name: 'Canyon Ridge',
    description: 'Sunset desert pass with big climbs and blind crests.',
    theme: 'canyon',
    timeOfDay: 18.2,
    music: 2,
    halfWidth: 7,
    runoff: 5.5,
    points: [
      [0, 0, 10],
      [140, 8, 12],
      [265, -18, 18],
      [335, -100, 26],
      [325, -200, 30],
      [255, -262, 27],
      [165, -250, 22],
      [115, -305, 17],
      [145, -385, 13],
      [70, -450, 10],
      [-55, -440, 8],
      [-130, -375, 6],
      [-120, -285, 9],
      [-185, -222, 13],
      [-285, -232, 16],
      [-345, -160, 18],
      [-315, -70, 16],
      [-230, -18, 13],
      [-115, -6, 11],
    ],
  },
];

/** Free roam is not a loop; it is described in freeroam.js. */
export const FREE_ROAM = {
  id: 'freeroam',
  name: 'Free Roam',
  description: 'Open sandbox with ramps, hills, cones and coins to collect.',
  theme: 'freeroam',
  timeOfDay: 11,
  music: 3,
};

export function getTrackDef(id) {
  return TRACKS.find((t) => t.id === id) || TRACKS[0];
}

/** Cost (coins) to unlock the reverse layout of each track. */
export const REVERSE_COST = 400;
