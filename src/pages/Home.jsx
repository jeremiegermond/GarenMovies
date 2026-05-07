import { Tv, Users } from 'lucide-react';

export default function Home({ onPick }) {
  return (
    <div className="app home-app">
      <div className="home">
        <h1 className="home-brand">GarenMovies</h1>
        <p className="home-tagline">
          Regardez vos films entre amis, où qu'ils soient.
          Hébergez votre propre salon ou rejoignez celui d'un proche.
        </p>
        <div className="home-actions">
          <button className="home-action" onClick={() => onPick('host')}>
            <div className="home-action-icon">
              <Tv size={20} strokeWidth={1.75} />
            </div>
            <h2 className="home-action-title">Héberger un salon</h2>
            <p className="home-action-desc">
              Diffusez les films de votre disque dur à vos amis, partout dans le monde.
            </p>
          </button>
          <button className="home-action" onClick={() => onPick('client')}>
            <div className="home-action-icon">
              <Users size={20} strokeWidth={1.75} />
            </div>
            <h2 className="home-action-title">Rejoindre un salon</h2>
            <p className="home-action-desc">
              Connectez-vous au salon d'un ami pour regarder un film synchronisé.
            </p>
          </button>
        </div>
      </div>
    </div>
  );
}
