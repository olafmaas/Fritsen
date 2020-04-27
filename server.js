///// SETUP SERVER

const express = require('express');
const socket = require('socket.io');

//App Setup
const app = express();
const server = app.listen(process.env.PORT || 9999, function() {
	console.log("App listening on Port " + 9999);
});

//Static files
app.use(express.static("public"));

//Socket setup
const io = socket(server);

// GLOBAL DATA

var players = {};
var matches = {};
var queueNumber = 1;

// CONSTANTS
const vuileFritsTime = 9000;
const vuileFritsTimeout = 2000;
const baudetTime = 10000;
const drinkTimeOut = 10000;
const startHand = 5;
const maxParticipants = 6;
const log = true;


// SOCKET CONNECTION FUNCTIONS

io.sockets.on('connection', function (socket) {
	if(log) console.log("connection: " + socket.id);
	players[socket.id] = {
		matchId: false,
		inQueue: false
	};

    // Match Events
    socket.on('disconnect', onDisconnect);
    socket.on('joinQueue', function(name){ joinQueue(socket.id, name); });
    socket.on('startMatch', createMatches);

    // Fritsen Events
    socket.on('playCard', function(cardId, pileId){ playCard(socket.id, cardId, pileId); });
    socket.on('frits', fritsCards);
    socket.on('vuileFrits', vuileFritsCards);
	if(log) console.log("connection handled");
});


// SOCKET HANDLERS

function onDisconnect(){
	if(log) console.log("disconnect: " + this.id);
	var player = players[this.id];
	if(!player) return;

	var matchId = player.matchId;
	if(matchId){
		var match = matches[matchId];
		if(match){
			match.playerIds.forEach(function(id) {
				var p = players[id];
				if(p) p.done = true; 
			});
			player.done = false;
			var rule = getRule("Disconnect", player.name);
			checkWin(match, player, result);
		}
	} else if (player.inQueue){
		player.inQueue = false;
		var queue = getQueue();
		queue.forEach(function(p) { io.to(p.id).emit('queue', queue); });
	}
		
	
	delete players[this.id];
	if(log) console.log("player deleted");
}


// MATCH HANDLERS

function joinQueue(socketId, name) {
	if(log) console.log("joinQueue: " + socketId + " - " + name);
	var player = players[socketId];
	if(!player) return;

	player.inQueue = queueNumber;
	queueNumber++;

	player.matchId = false;
	player.name = name;
	player.done = false;
	player.vuilefrits = 0;
	player.cards = [];
	
	var queue = getQueue();
	queue.forEach(function(p) { io.to(p.id).emit('queue', queue); });
	if(log) console.log("queue join handled");
}

function createMatches(){
	var participants = getQueue();

	if(participants.length === 0 || this.id !== participants[0]["id"])
		return;

	// while number of players is in abundance keep creating matches of max size
	while (participants.length > 2 * maxParticipants){		
		createMatch(participants.splice(0, maxParticipants));
	}

	// if larger than maximum number split in two groups else all in one group
	if(participants.length > maxParticipants){
		var playerNum = participants.length / 2;	
		createMatch(participants.splice(0, playerNum));
	}

	createMatch(participants);
}

function createMatch(participants) {
	if(log) console.log("createMatch: " + participants.length);

	var matchId = createId();
	matches[matchId] = { playerIds: [], state: "vuileFrits", turnId: false, piles: [], frits: false, lastMove: -1, deck: createDeck(), baudetTimeout: false };
	var match = matches[matchId];

	placeWillemAndFrits(participants);

	participants.forEach( function(p) {
		var player = players[p.id];
		if(player){
			player.matchId = matchId;
			player.inQueue = false;
			getHand(player, match.deck);
			match.playerIds.push(p.id);
		}
	});

	//jokerPile
	var jokerPile = addPile(match);
	jokerPile.jokerPile = true;
	var firstPile = addPile(match);
	var pcs = firstPile.cards;
	
	//while no joker
	while(match.deck.length > 0 && (pcs.length === 0 || pcs[pcs.length - 1].identity === "Joker" )){
		drawCards(firstPile.cards, match.deck, 1);
	}

	match.playerIds.forEach( function(id){ io.to(id).emit("match started"); });
	updateCards(match, false);

	setTimeout(function(){
		var m = matches[matchId];
		if(m){
			match.state = "playing";
			nextPlayer(m);
			updateCards(m, getRule("Update", false));
		}
	}, vuileFritsTime);
	if(log) console.log("match created");
}


// FRITS MOVE HANDLERS

function playCard(socketId, cardId, pileId) {
	if(log) console.log("playCard: " + socketId + " -> (" + cardId + ", " + pileId + ")");
	
	
	var match = findMatchBySocketId(socketId);
	var player = players[socketId];
	if(!match || !player) return;
	
	if((match.state === "vuileFrits" || match.state === "timeout"))
		return;

	var hand = player.cards;
	var piles = match.piles;

	if(cardId >= hand.length || pileId >= piles.length)
		return updateCards(match, getRule("Fout", player.name));

	if((match.state === "playing" && match.turnId !== socketId))
		return updateCards(match, getRule("DesBeurt", player.name));

	var result = placeOnPile(cardId, pileId, match, hand, socketId, player);

	//valid move
	if (result.value > 0) {
		//Remove player when he has no cards left
		if(hand.length === 0) {
			player.done = true;

			var rule = getRule("Uit", player.name);
			result = new Rule(rule.name, rule.description + result.description, rule.value);

			if(checkWin(match, player, result))
				return;
		}

		if(match.state === "baudet" && match.baudetTimeout){
			clearTimeout ( match.baudetTimeout );
			match.baudetTimeout = false;
		}
		
		match.state = "playing";
		match.lastMove = pileId;
		match.frits = false;

		if (result.name === "Baudet"){
			match.state = "baudet";

			match.baudetTimeout = setTimeout(function(){
				newHand(hand, match.deck);
				match.state = "playing";
				match.baudetTimeout = false;
				nextPlayer(match);
				updateCards(match, getRule("Update", false));
			}, baudetTime);
		} else {			
			nextPlayer(match);
					
			if(result.value === 1){
				match.state = "timeout";
				setTimeout(function(){
					match.state = "playing";
					updateCards(match, getRule("Update", false));
				}, drinkTimeOut);
			}
		}
	}
	
	return updateCards(match, result);
}

function fritsCards(){
	if(log) console.log("fritsCards: " + this.id);
	var match = findMatchBySocketId(this.id);
	var player = players[this.id];
	
	if((!match || !player || match.state === "vuileFrits" || match.state === "timeout"))
		return;
	
	if(!match.frits && match.state === "playing" && match.turnId === this.id){
		match.state = "playing";
		drawCards(player.cards, match.deck, 2);
		match.frits = true;	

		//add new pile if no pile is empty
		if (match.piles[match.piles.length - 1].cards.length > 0)
			addPile(match);

		var result = getRule("Frits", player.name);
		updateCards(match, result);
	}else{
		if (match.turnId !== this.id && match.state !== "baudet"){
			return updateCards(match, getRule("DesBeurt", player.name));			
		} else if (match.turnId === this.id && match.frits) {
			return updateCards(match, getRule("AlGefritst", player.name));		
		} else {			
			return updateCards(match, getRule("Fout", player.name));	
		}
	}
	if(log) console.log("fritsCards handled");
}

function vuileFritsCards() {
	if(log) console.log("vuileFritsCards: " + this.id);
	var match = findMatchBySocketId(this.id);
	if(match && match.state === "vuileFrits"){
		var player = players[this.id];
		if(player && Date.now() > player.vuilefrits){
			var hand = player.cards;
			newHand(hand, match.deck);
			var result = getRule("VuileFrits", player.name);
			updateCards(match, result);
			player.vuilefrits = Date.now() + vuileFritsTimeout;
		}
	}
	if(log) console.log("vuileFritsCards handled");
}


// FRITS GAME HELPER FUNCTIONS

function getQueue(){
	var queue = [];
	for(playerId in players){
		var p = players[playerId];
		if(p && p.inQueue) 
			queue.push({name: p.name, id: playerId, num: p.inQueue});
	}
	queue.sort(function(a, b) { return a.num - b.num; });

	var willemIndex = minHammingDistanceIndex(queue, "Willem");
	if(willemIndex >= 0)
		queue.unshift(queue.splice(willemIndex, 1)[0]);

	return queue;
}

function updateCards(match, result) {
	var piles = [];
	for (var i = 0; i < match.piles.length; i++) {
		var asStrings = match.piles[i].cards.map(c => Identities[c.identity] + Suits[c.suit]);
		piles.push(asStrings);
	}

	var turn = getTurnPlayer(match);

	for (var i = 0; i < match.playerIds.length; i++) {
		var playerId = match.playerIds[i];
		var player = players[playerId];
		if(player){
			if(!player.done && player.cards.length === 0){
				player.done = true;
				checkWin(match, player, getRule("Uit", player.name));
			}
			var cardStrings = player.cards.map(c => Identities[c.identity] + Suits[c.suit]);
			io.to(playerId).emit("update cards", cardStrings, match.deck.length, piles, match.frits, match.lastMove, result);
		}
	}
	if(log) console.log("updated cards");	
}

function getTurnPlayer(match){
	var player = players[match.turnId];
	if(!player)	return false;
	
	return {name: player.name, id: match.turnId, cards: player.cards.length};
}


function nextPlayer(match){
	var index = match.playerIds.indexOf(match.turnId);
	if(index < 0) {		
		match.turnId = match.playerIds[0];
		return;
	}

	var next = (index + 1) % match.playerIds.length;
	match.turnId = match.playerIds[next];

	var p = players[match.turnId];
	if(p && p.done)
		nextPlayer(match);
}

function checkWin(match, player, result){
	var inGame = 0;
	var loserName = player.name;
	match.playerIds.forEach(function(id) {
		var p = players[id];
		if(p && !p.done){
			inGame++; 
			loserName = p.name;
		}
	});

	if(inGame <= 1){
		updateCards(match, result);
		match.playerIds.forEach( function(id){ io.to(id).emit("game over", loserName); });
		removeMatch(player.matchId);
		return true;
	}
	return false;
}


// ID FUNCTIONS

function createId() {
	var id = "";
	var charset = "ABCDEFGHIJKLMNOPQRSTUCWXYZabcdefghijklmnopqrtsuvwxyz1234567890";
	for (var i = 0; i < 16; i++) {
		id += charset.charAt(Math.floor(Math.random() * charset.length));
	}
	return id;
}

function findMatchBySocketId(socketId) {
	var player = players[socketId];
	if(player && player.matchId){
		return matches[player.matchId];
	}
	return false;
}

function removeMatch(matchId) {
	delete matches[matchId];
}


//Card Games
var Suits = Object.freeze({"Clubs":"C", "Hearts":"H", "Spades":"S", "Diamonds":"D", "Red": "R", "Black":"B"})
var Identities = Object.freeze({"Joker":"X", 2:"2", 3:"3", 4:"4", 5:"5", 6:"6", 7:"7", 8:"8", 9:"9", 10:"T", 11:"J", 12:"Q", 13:"K", 14:"A"})

function Card(identity, suit) {
  this.identity = identity;
  this.suit = suit;
}

function createDeck(){
	var numJokers = 3;
	var deck = [];
	var suits = ["Clubs", "Hearts", "Spades", "Diamonds"]
	suits.forEach(function(suit) {
		for (var i = 2; i <= 14; i++){
			deck.push(new Card(i, suit));
		}
	});

	var colors = ["Red", "Black"]
	for (var i = 0; i < numJokers; i++){
		deck.push(new Card("Joker", colors[i%2]));
	}
	return shuffle(deck);
}

function shuffle(deck) {
	var m = deck.length, t, i;

	// While there remain elements to shuffle…
	while (m) {

		// Pick a remaining element…
		i = Math.floor(Math.random() * m--);

		// And swap it with the current element.
		t = deck[m];
		deck[m] = deck[i];
		deck[i] = t;
	}

	return deck;
}

function getHand(player, deck){
	player.cards = [];
	drawCards(player.cards, deck, startHand);
}

function drawCards(cards, deck, numCards){
	numCards = Math.min(numCards, deck.length);
	for (var i = 0; i < numCards; i++){
		cards.push(deck.pop());
	}
}

function newHand(hand, deck){
	var numCards = hand.length;
	for (var i = 0; i < numCards; i++){
		deck.unshift(hand.pop());
	}
	drawCards(hand, deck, numCards);
}


// Fritsen Rules

function Pile(cards){
  this.cards = cards;
}

function addPile(match){
	var pile = new Pile([]);
	match.piles.push(pile);
	return pile;
}

function Rule(name, description, value) {
  this.name = name;
  this.description = description;
  this.value = value;
}

var Rules = [
	new Rule("DesBeurt", " - Fritsje des: Je bent niet aan de beurt", 0),
	new Rule("Fout", " - Fritsje des: Zet is niet mogelijk, neem 1 fritsje", 0),
	new Rule("Goed", " heeft een kaart opgelegd", 2),
	new Rule("Update", "", 2),
	new Rule("Offer", " - Offerfrits: Neem 1 fritsje", 1),
	new Rule("Joker", " - Joker: Alle anderen nemen 1 fritsje", 1),
	new Rule("Kim", " - Kim: Alle anderen nemen 1 fritsje", 1),
	new Rule("VierdeKim", "Vierde Kim: Alle anderen nemen 2 fritsjes", 1),
	new Rule("Joris", " - Jorisje: Alle anderen nemen 1 fritsje", 1),
	new Rule("Lisa", " - Lisa: Alle anderen nemen 1 fritsje", 1),
	new Rule("Baudet", " - Baudet: Ruil je hand met de stapel en neem 2 fritsjes", 1),
	new Rule("BaudetFout", " - Je kunt niet uitkomen met Baudet, neem 1 fritsje", 0),
	new Rule("Klaver", " - Klaver! Je voorkomt dat Thierry aan de macht komt. De speler met Baudet mag niet ruilen", 1),
	new Rule("Erik", " - Erikje! Je hebt jezelf geklaverd! neem zelf nog wel 2 fritsjes voor het spelen van Baudet", 1),
	new Rule("KlaverFout", " - Je kunt nu alleen de klaveren 3 op de laatste 6 leggen", 0),
	new Rule("DubbelNegen", " - Iedereen Dubbelfrits! Alle anderen nemen 2 fritsjes", 1),
	//new Rule("AasKoning", "Nice! Aas en Koning op Kim", 1),
	new Rule("Frits", " heeft gefritst", 1),
	new Rule("AlGefritst", " - Je hebt al gefritst, neem 1 fritsje des", 0),
	new Rule("JokerUit", " - Je mag niet uitkomen met een Joker, neem 1 fritsje", 0),
	new Rule("JokerFout", " - Jokers mogen alleen op de jokerstapel, neem 1 fritsje", 0),
	new Rule("Uit", " is uitgefritst. ", 1),
	new Rule("VuileFrits", " heeft een vuile frits gedaan", 0),
	new Rule("Disconnect", " heeft het spel verlaten", 0)
];

function getRule(name, playerName) {
	if(log) console.log("got rule" + name + " by " + playerName);
	var rule = Rules.find(function(r) { return r.name === name; });
	
	if(playerName){
		rule = JSON.parse(JSON.stringify(rule));
		rule.description = playerName + rule.description;
	}
	
	return rule;
}

//Rules - Possible placement:
//1. Only if card is Joker on Joker pile (Joker)
//2. Card is a 9
//3. Queen on a Queen (Kim)
//4. Jack of clubs on Red Queen or vice versa (Joris)
//5. King on Ace of Hearts or vice versa (Lisa)
//6. 6 on a Queen (Baudet)
//7. 3 of Clubs on a 6 after move Baudet (Klaver)
//8. Same suit with higher value
//9. Same suit with 1 lower value (Offer)
//10. Same suit with 2 on Ace
//11. All same suit: King + Ace on Queen - Not implemented


function checkCards(card, pileId, match, hand, socketId, player)
{	
    //7. 3 of Clubs on the last 6, when baudet is executed (Klaver) 
	//   first check as all other moves should be rejected during the baudetTimeout
	if(match.state === "baudet"){
		if(card.identity === 3 && card.suit === "Clubs" && match.lastMove === pileId)
		{
			if(match.turnId === socketId)
				return getRule("Erik", player.name);
			else
				return getRule("Klaver", player.name);
		}
		else
			return getRule("KlaverFout", player.name);
	}


	var pile = match.piles[pileId];

	//1. Only if card is Joker on Joker pile (Joker)
	if (card.identity === "Joker" || pile.jokerPile)
	{
		if (card.identity === "Joker" && hand.length === 1)
			return getRule("JokerUit", player.name);
		else if (card.identity === "Joker" && pile.jokerPile)
			return getRule("Joker", player.name);
		else
			return getRule("JokerFout", player.name);
	}

	if(pile.cards.length === 0){
		if(match.frits)
			return getRule("Goed", player.name);
		else
			return getRule("Fout", player.name);
	}

	var top = pile.cards[pile.cards.length - 1];
  
	var cardId = Identities[card.identity];
	var pileId = Identities[top.identity];
	var cardSuit = Suits[card.suit];
	var pileSuit = Suits[top.suit];

	//2. Card is a 9
	if (cardId === '9')
	{
		if(pileId === '9')
			return getRule("DubbelNegen", player.name);
		else
			return getRule("Goed", player.name);
	}

	//3. Queen on a Queen (Kim)
	if (pileId === 'Q')
	{
		if(cardId === 'Q')
		{
			for(var i = pile.cards.length - 1; i >= 0; i--){
				var c = Identities[pile.cards[i].identity];
				if (c !== 'Q')
					break;
				
				if(i <= pile.cards.length - 3)
					return getRule("VierdeKim", player.name);					
			}
			return getRule("Kim", player.name);
		}

		//4. Jack of clubs on Red Queen or vice versa (Joris)
		if (cardId === 'J' && cardSuit === 'C' && (pileSuit === 'H' || pileSuit === 'D'))
			return getRule("Joris", player.name);

		//6. 6 on a Queen (Baudet)
		if (cardId === '6'){
			if(hand.length > 1)
				return getRule("Baudet", player.name);
			else
				return getRule("BaudetFout", player.name);
		} 
	}

	//4. Joris Reverse
	if (pileId === 'J' && pileSuit === 'C')
	{
		if (cardId === 'Q' && (cardSuit === 'H' || cardSuit === 'D'))
			return getRule("Joris", player.name);
	}

	//5. King on Ace of Hearts or vice versa (Lisa)
	if((cardId === 'A' && cardSuit === 'H') || (pileId === 'A' && pileSuit === 'H'))
	{
		if (cardId === 'K' || pileId === 'K')
			return getRule("Lisa", player.name);
	}

	if(cardSuit === pileSuit)
	{
		var cid = card.identity;
		var pid = top.identity;

		//8. Same suit with higher value
		if (cid > pid)
		{
			return getRule("Goed", player.name);
		}

		//9. Same suit with 1 lower value (Offer)
		if (cid === pid - 1)
			return getRule("Offer", player.name);

		//10. Same suit with 2 on Ace
		if (cardId === '2' && pileId === 'A')
			return getRule("Goed", player.name);
	}

	return getRule("Fout", player.name);
}

function placeOnPile(cardId, pileId, match, hand, socketId, player)
{
	var card = hand[cardId];
	var res = checkCards(card, pileId, match, hand, socketId, player);

	if (res.value > 0)
	{
		var pile = match.piles[pileId];

		pile.cards.push(card);
		hand.splice(cardId, 1);
	}

	return res;
}


// Helper Functions

// Hamming function for different size strings: find smallest match between strings.
function HammingDistance(a, b){
	// make sure a is smallest
	a = a.toLowerCase();
	b = b.toLowerCase();
	if(a.length > b.length){
		var c = b;
		b = a;
		a = c;
	}
	var diff = b.length - a.length;
	var minDist = b.length;
	for (var i = 0; i <= diff; i++){
		var dist = diff;
		for (var j = 0; j < a.length; j++){
			if(a[j] !== b[(j+i)])
				dist++;
		}
		if(dist < minDist)
			minDist = dist;
	}
	return minDist;
}

// return closest player closest to name, maximum 3 difference
function minHammingDistanceIndex(participants, name){
	var names = participants.map(p => p.name);

	var index = -1;
	var minDist = 4;

	for (var i = 0; i < names.length; i++){
		var dist = HammingDistance(names[i], name);
		if(dist < minDist){
			minDist = dist;
			index = i;
		}
	}
	return index;
}

// player most like willem is first and most like frits is last
function placeWillemAndFrits(participants){
	if(participants.length >= 2){
		var fritsIndex = minHammingDistanceIndex(participants, "Frits");
		if(fritsIndex >= 0)
			participants.push(participants.splice(fritsIndex, 1)[0]);

		var willemIndex = minHammingDistanceIndex(participants, "Willem");
		if(willemIndex >= 0)
			participants.unshift(participants.splice(willemIndex, 1)[0]);
	}
}
