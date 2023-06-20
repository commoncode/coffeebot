### CoffeeBot

Coffeebot is a Slackbot used to track the coffee consumption of users in a slack workspace. This was
hacked out just before international coffee day, 2000.

It was initially set up to try to run on Firebase, but that didn't work well because of the startup
time of workers. It was then set up to try to use Qovery, but Qovery wouldn't work - it just kept
producing unusable environments. It was finally set up as a simple docker container, and now runs
happily on a box running Caprover.

It's poorly written, hacked together in a short space of time and given virtually no attention
thereafter, but a single instance has run happily for 1.5 years so it seems to be remarkably
stable considering.