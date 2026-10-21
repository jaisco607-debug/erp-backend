// Only these departments GIVE the cloth its colour (owner: Dyeing). Every other department only shows the
// colour the cloth already has. Used by the job rules (jobService) and by the colour list routes, so the
// people who may pick or add a colour are exactly the people of these departments (and the SO card desk).
// Not to be confused with services.tracksColour, which is true for almost every department.
module.exports = ['DYEING'];
