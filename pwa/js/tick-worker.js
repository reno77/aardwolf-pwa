// A heartbeat that survives a hidden tab.
//
// Chrome throttles timers in a page that is not visible -- after five minutes of being
// hidden, "intensive throttling" allows a setTimeout roughly once a MINUTE. Everything
// the unattended campaign run is paced by then stretches: an eight-second rest tick
// becomes a minute, a five-minute cooldown becomes however long Chrome feels like, and
// the run looks stalled when it is only being starved of ticks. Watched live: the tab
// was occluded and a cooldown round had not fired ten minutes after it was scheduled.
//
// Worker timers are not throttled that way, so the periodic checks are driven from here
// and the page reacts to the message instead of waiting on its own clock.
self.setInterval(() => self.postMessage(Date.now()), 1000);
