# Game Sessions

## Player scope

ShogiHome Lab targets users of externally configured USI engines. The upstream
beginner and random built-in players are retired rather than introducing a
second engine execution model for server-owned games. Both default players are
human. Loading legacy browser game settings converts built-in player selections
to the default human settings; existing records and player names in records are
not modified. New requests cannot select a retired built-in player.
