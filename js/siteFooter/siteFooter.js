const SITE_FOOTER_IMAGES = new URL("../../images/", document.currentScript.src).href;

const SITE_FOOTER_LINKS = [
  {
    label: "LinkedIn",
    href: "https://www.linkedin.com/in/joe-vessell-167a4a12/",
    sprite: "brands.svg#linkedin",
  },
  {
    label: "Goodreads",
    href: "https://www.goodreads.com/user/show/13632898-joe-vessell",
    sprite: "brands.svg#goodreads",
  },
  {
    label: "GreatGoals",
    href: "https://greatgoals.app/share/profile/VEpFgNqxTyPNbw5xjFu1CUhnYnn1",
    img: "icon-great-goals.svg",
  },
];

class SiteFooter extends HTMLElement {
  connectedCallback() {
    const links = SITE_FOOTER_LINKS.map(
      (link) => `
        <a target="_blank" rel="noopener" class="primary" href="${link.href}">
          ${
            link.sprite
              ? `<svg><use xlink:href="${SITE_FOOTER_IMAGES}${link.sprite}"></use></svg>`
              : `<img class="icon" src="${SITE_FOOTER_IMAGES}${link.img}" alt="" />`
          }
          <span>${link.label}</span>
        </a>`
    ).join("");

    this.innerHTML = `
      <footer>
        <section id="contact" class="container">
          <article>
            <h2>Social</h2>
            <p>${links}</p>
          </article>
        </section>
      </footer>`;
  }
}

customElements.define("site-footer", SiteFooter);
