// state.js -- extracted from index.html
// =============================================================================
// STATE
// =============================================================================

// Campaign / Quest State
export const output=document.getElementById('output');
export const WS_URL=(location.protocol==='https:'?'wss://':'ws://')+location.host+'/ws';


// =============================================================================
// FADO ALIAS EXPANSIONS
// =============================================================================
export const commandMap={
  'gc':'get all from corpse into pack;get all from corpse 2 into pack;get all from corpse 3 into pack;get all from corpse;get all from corpse 2;get all from corpse 3',
  'food':"cast 'create food';cast 'create food';eat mush;eat mush",
  'bless':"cast 'bless'",
  'heal':"cast 'cure light';cast 'cure light';cast 'cure light'",
  'spellup':"cast 'armor';cast 'bless';cast 'detect invis';cast 'detect hidden'",
  'eqsearch':'eqsearch',
  'rec':'recall',
  'wpn':'poly',
  'wpn2':'poly2',
  'wear171':'Get lea b;get lea b;get util b;get util b;get pant b;get lea b;get eye b;get ear b;get ear b;get cho b;get cho b;get cap b;wear lea;wear util;wear util;Wear pant;wear lea;Wear eye;Wear ear;wear cho;Wear cap;put explo bb;put lun bb;put mad bb;put bel bb;put trou bb;rem whis;put whis bb;wear ear;get blad b;get blad b;rem scar;rem scar;put scar bb;put scar bb;wear bla;Wear bla;Wear jac;put tren bb',
  'wear200':'wear 200',
  'wearboot':'rem complex;put complex bb;rem complex;put complex bb;rem tiger;put tiger bb;rem green;rem green;put green bb;put green bb;rem dust;put dust bb;rem eye;put eye bb;rem leet;put leet bb;rem spill;put spill bb;rem trump;put trump bb;rem trump;put trump bb;get bcg b;wear bcg;get vest b;wear vest;get plug b;get plug b;wear plug;wear plug;get cloud b;wear cloud;get pt b;wear pt;get c4 b;wear c4;get tat b;wear tat;get ban b;wear ban;get mic b;wear mic;get mic b;wear mic;get boot b;wear boot;get general b;wear gen;get comp b;wear comp;get shoot b;wear shoot;put qui bb;put spark bbbb',
  'attmarbu':'marbu;marbu;marbu;marbu;marbu;pou;pou',
  'attspi':'spi;spi;spi;spi;spi;spi;pou',
  'attgreen':'green;green;green;green;green;pou',
  'attsweep':'sweep;sweep;sweep;sweep;sweep;pou',
  'attkobold':'kobold;kobold;kobold;kobold;kobold;pou',
  'attgen':'gen;gen;gen;gen;gen;pou',
  'attcobra':'cobra;cobra;cobra;cobra;cobra;pou',
  'atthydra':'hydra;hydra;hydra;hydra;hydra;pou',
  'attraven':'raven;raven;raven;raven;raven;pou',
  'attcow':'cow;cow;cow;cow;cow;pou',
  'attcult':'cult;cult;cult;cult;cult;pou',
  'attmarbu2':'marbu;marbu;marbu;marbu;marbu;marbu;pou',
  'attspi2':'spi;spi;spi;spi;spi;spi;spi;pou',
  'quest':'quest',
  'crr':'campaign request',
  'camp':'campaign',
  'ht':'hunt',
  'qw':'where',
};

// =============================================================================
// MOB AUTO-ATTACK TRIGGER DEFINITIONS
// =============================================================================
export const triggerDefs=[
  // Built-in triggers (always enabled)
  {name:'auto-wake', enabled:true, once:false, p:/You dream about/i, cmd:'wake'},
  {name:'auto-stand', enabled:true, once:false, p:/You go to sleep/i, cmd:'stand'},
  {name:'auto-hunger', enabled:true, once:false, p:/You are hungry/i, cmd:"cast 'create food';eat mushroom"},
  {name:'auto-thirst', enabled:true, once:false, p:/You are thirsty/i, cmd:"cast 'create water';drink water"},
  // {name:'auto-starve', enabled:true, once:false, p:/You are starving/i, cmd:'cf;cf'},
  {name:'auto-dehydrate', enabled:true, once:false, p:/You are dehydrated/i, cmd:"cast 'create water';drink water"},
  {name:'login-name', enabled:true, once:true, p:/What be thy name/i, cmd:'auto_name'},
  {name:'login-pass', enabled:true, once:true, p:/Password:/i, cmd:'auto_pass'},
];

// Fado triggers loaded from DB - all 92 combat/status/utility triggers
