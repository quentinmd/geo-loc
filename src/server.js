// server.js
const express = require('express');
const http = require('http');
const socketio = require('socket.io');
const path = require('path');
const fs = require('fs');
require('dotenv').config(); // Chargement des variables d'environnement

const app = express();
const server = http.createServer(app);
const io = socketio(server, {cors: {origin: "*"}});

// Stockage des meilleurs scores et des joueurs récents
const leaderboard = [];
const recentPlayers = [];
const MAX_LEADERBOARD_SIZE = 10;
const MAX_RECENT_PLAYERS = 5;

// Fonction pour sauvegarder un score dans le classement
function saveScore(player) {
  // Ne pas enregistrer les scores anonymes ou vides
  if (!player.pseudo || player.pseudo === 'Joueur') return;
  
  // Vérifier si le joueur existe déjà
  const existingIndex = leaderboard.findIndex(p => p.pseudo === player.pseudo);
  if (existingIndex >= 0) {
    // Mettre à jour le score si c'est meilleur
    if (player.score > leaderboard[existingIndex].score) {
      leaderboard[existingIndex].score = player.score;
      leaderboard[existingIndex].date = new Date().toISOString();
    }
  } else {
    // Ajouter un nouveau joueur
    leaderboard.push({
      pseudo: player.pseudo,
      score: player.score,
      date: new Date().toISOString()
    });
  }
  
  // Trier et limiter la taille du classement
  leaderboard.sort((a, b) => b.score - a.score);
  if (leaderboard.length > MAX_LEADERBOARD_SIZE) {
    leaderboard.length = MAX_LEADERBOARD_SIZE;
  }
}

// Fonction pour enregistrer un joueur récent
function addRecentPlayer(pseudo) {
  if (!pseudo || pseudo === 'Joueur') return;
  
  // Supprimer si existe déjà
  const existingIndex = recentPlayers.findIndex(p => p.pseudo === pseudo);
  if (existingIndex >= 0) {
    recentPlayers.splice(existingIndex, 1);
  }
  
  // Ajouter en tête de liste
  recentPlayers.unshift({
    pseudo: pseudo,
    time: new Date().toISOString()
  });
  
  // Limiter la taille
  if (recentPlayers.length > MAX_RECENT_PLAYERS) {
    recentPlayers.length = MAX_RECENT_PLAYERS;
  }
}

// Au lieu de servir simplement les fichiers statiques
// On va intercepter la requête pour index.html
app.get('/', (req, res) => {
  // Lire le fichier index.html
  const indexPath = path.join(__dirname, 'public', 'index.html');
  fs.readFile(indexPath, 'utf8', (err, data) => {
    if (err) {
      console.error('Erreur de lecture du fichier index.html:', err);
      return res.status(500).send('Erreur serveur');
    }
    
    // Remplacer le placeholder par la clé API
    const apiKey = process.env.GOOGLE_MAPS_API_KEY || '';
    const modifiedHtml = data.replace('GOOGLE_MAPS_API_KEY_PLACEHOLDER', apiKey);
    
    res.send(modifiedHtml);
  });
});

// Servir les autres fichiers statiques normalement
app.use(express.static(path.join(__dirname, 'public')));

const games = new Map();

// Statistiques des joueurs
let onlinePlayers = 0;
let totalPlayers = 0;

// Charger le nombre total de joueurs depuis un fichier si disponible
try {
  const statsData = fs.readFileSync(path.join(__dirname, 'player-stats.json'), 'utf8');
  const stats = JSON.parse(statsData);
  totalPlayers = stats.total || 0;
} catch (err) {
  console.log('Aucune statistique précédente trouvée, démarrage à zéro');
  totalPlayers = 0;
}

io.on('connection', (socket) => {
  console.log('Nouvelle connexion:', socket.id);

  // Incrémenter le nombre de joueurs connectés
  onlinePlayers++;
  totalPlayers++;

  // Sauvegarder les statistiques périodiquement
  savePlayerStats();

  // Envoyer les statistiques aux clients qui les demandent
  socket.on('getPlayerStats', () => {
    socket.emit('playerStats', {
      online: onlinePlayers,
      total: totalPlayers
    });
  });

  socket.on('createGame', (config) => {
    const gameId = generateGameId();
    const player = {
      id: socket.id,
      pseudo: config.pseudo,
      score: 0,
      isHost: true
    };
    
    games.set(gameId, {
      players: new Map([[socket.id, player]]),
      rounds: config.rounds,
      currentRound: 0,
      locations: [],
      started: false
    });
    
    socket.join(gameId);
    socket.gameId = gameId;
    socket.emit('gameCreated', gameId);
    io.to(gameId).emit('playerJoined', Array.from(games.get(gameId).players.values()));
  });

  socket.on('joinGame', (gameId, pseudo) => {
    gameId = gameId.toUpperCase();
    
    if (!games.has(gameId)) {
      return socket.emit('gameError', 'Partie introuvable');
    }
    
    const game = games.get(gameId);
    
    if (game.started) {
      return socket.emit('gameError', 'La partie a déjà commencé');
    }
    
    const player = {
      id: socket.id,
      pseudo: pseudo,
      score: 0,
      isHost: false
    };
    
    game.players.set(socket.id, player);
    socket.join(gameId);
    socket.gameId = gameId;
    
    // Informer tout le monde dans la partie qu'un joueur a rejoint
    io.to(gameId).emit('playerJoined', Array.from(game.players.values()));
    
    // Informer le joueur qui vient de rejoindre qu'il a bien été connecté
    socket.emit('joinedGame', gameId, Array.from(game.players.values()));
  });

  socket.on('leaveGame', (gameId) => {
    if (!gameId || !games.has(gameId)) return;
    
    const game = games.get(gameId);
    game.players.delete(socket.id);
    
    if (game.players.size === 0) {
      // Si plus personne dans la partie, on la supprime
      games.delete(gameId);
    } else {
      // Sinon on informe les autres joueurs
      io.to(gameId).emit('playerJoined', Array.from(game.players.values()));
      
      // Si l'hôte quitte, on désigne un nouvel hôte
      if (Array.from(game.players.values()).every(p => !p.isHost)) {
        const newHost = Array.from(game.players.values())[0];
        newHost.isHost = true;
        io.to(gameId).emit('playerJoined', Array.from(game.players.values()));
      }
    }
    
    socket.leave(gameId);
    delete socket.gameId;
  });

  socket.on('startMultiGame', async (gameId, rounds) => {
    if (!gameId || !games.has(gameId)) return;
    
    const game = games.get(gameId);
    
    // Vérifier si le joueur est l'hôte
    const player = game.players.get(socket.id);
    if (!player || !player.isHost) return;
    
    // Mettre à jour le nombre de manches si fourni
    if (rounds) {
      game.rounds = rounds;
    }
    
    // On ne génère plus les emplacements ici, on attend le client
    socket.emit('requestLocations', gameId, game.rounds);
  });

  socket.on('proposeLocations', (gameId, locations) => {
    if (!gameId || !games.has(gameId)) return;
    
    const game = games.get(gameId);
    game.locations = locations;
    game.started = true;
    
    // Envoyer les données de départ à tous les joueurs
    io.to(gameId).emit('gameStarted', {
      rounds: game.rounds,
      currentRound: 0,
      locations: game.locations,
      players: Array.from(game.players.values())
    });
    
    console.log(`Partie ${gameId} démarrée avec ${game.players.size} joueurs et ${game.rounds} manches`);
  });

  socket.on('submitGuess', (gameId, guessData) => {
    if (!gameId || !games.has(gameId)) return;
    
    const game = games.get(gameId);
    const player = game.players.get(socket.id);
    
    if (!player) return;
    
    // Stocker le score du joueur
    player.score = (player.score || 0) + guessData.score;
    
    // Stocker le résultat pour ce tour
    if (!game.roundResults) {
      game.roundResults = new Map();
    }
    
    game.roundResults.set(socket.id, {
      playerId: socket.id,
      pseudo: player.pseudo,
      distance: guessData.distance,
      score: guessData.score
    });
    
    console.log(`Joueur ${player.pseudo} a deviné avec ${guessData.distance}km de distance, score: ${guessData.score}`);
    
    // Vérifier si tous les joueurs ont soumis leur réponse
    if (game.roundResults.size === game.players.size) {
      // Tous les joueurs ont répondu, on peut passer à la manche suivante
      const results = Array.from(game.roundResults.values());
      
      // Envoyer les résultats à tous les joueurs
      io.to(gameId).emit('roundComplete', results);
      
      // Après un délai, passer à la manche suivante
      setTimeout(() => {
        game.currentRound++;
        
        // Réinitialiser les résultats pour la prochaine manche
        game.roundResults = new Map();
        
        if (game.currentRound < game.rounds) {
          // Passer à la manche suivante
          io.to(gameId).emit('nextRound', game.currentRound);
        } else {
          // Fin de la partie
          const finalResults = Array.from(game.players.values())
            .map(p => ({ pseudo: p.pseudo, score: p.score }))
            .sort((a, b) => b.score - a.score); // Trier par score décroissant
          
          io.to(gameId).emit('endGame', finalResults);
        }
      }, 5000); // 5 secondes pour lire les résultats
    }
  });

  socket.on('disconnect', () => {
    console.log('Déconnexion:', socket.id);
    
    // Si le joueur était dans une partie, le retirer
    if (socket.gameId && games.has(socket.gameId)) {
      const gameId = socket.gameId;
      const game = games.get(gameId);
      
      game.players.delete(socket.id);
      
      if (game.players.size === 0) {
        games.delete(gameId);
      } else {
        io.to(gameId).emit('playerJoined', Array.from(game.players.values()));
        
        // Si l'hôte quitte, on désigne un nouvel hôte
        if (Array.from(game.players.values()).every(p => !p.isHost)) {
          const newHost = Array.from(game.players.values())[0];
          newHost.isHost = true;
          io.to(gameId).emit('playerJoined', Array.from(game.players.values()));
        }
      }
    }

    // Décrémenter lors de la déconnexion
    onlinePlayers--;
    
    // Mettre à jour les stats pour tous les clients
    io.emit('playerStats', {
      online: onlinePlayers,
      total: totalPlayers
    });
  });

  // Envoyer les données de classement
  socket.on('getLeaderboard', () => {
    socket.emit('leaderboardData', leaderboard);
  });

  // Envoyer les données des joueurs récents
  socket.on('getRecentPlayers', () => {
    socket.emit('recentPlayersData', recentPlayers);
  });

  // Enregistrer le joueur comme récent à la connexion
  socket.on('registerPlayer', (pseudo) => {
    if (pseudo) {
      addRecentPlayer(pseudo);
    }
  });

  // Dans le gestionnaire 'endGame' :
  socket.on('saveScore', (player) => {
    saveScore(player);
  });
});

// Fonction pour générer des lieux (similaire à findValidLocation du client)
async function generateLocations(count) {
  // Pour le moment, retournons des coordonnées aléatoires (à améliorer avec l'API StreetView)
  const locations = [];
  for (let i = 0; i < count; i++) {
    locations.push({
      lat: Math.random() * 160 - 80,
      lng: Math.random() * 360 - 180
    });
  }
  return locations;
}

function generateGameId() {
  return Math.random().toString(36).substr(2, 6).toUpperCase();
}

// Fonction pour sauvegarder les statistiques
function savePlayerStats() {
  fs.writeFileSync(
    path.join(__dirname, 'player-stats.json'),
    JSON.stringify({ total: totalPlayers }),
    'utf8'
  );
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
