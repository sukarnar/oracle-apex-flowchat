Paste this into Shared Components → Themes → Theme Roller → Custom CSS or into the page's CSS → Inline. It targets the class names Universal Theme uses for breadcrumbs: .t-Breadcrumb, .t-Breadcrumb-item, .t-Breadcrumb-label and .is-active. I haven't run it against a live APEX page.

Adjusting it

No chevrons: delete the "Optional: small chevron" block. The pills are then separated only by the gap.
Colours: the --pill-* variables use Theme Roller colours where it defines them and fall back to fixed values. Change the fallbacks, or set the variables directly, to use your brand colours.
Squarer pills: set --pill-radius: 6px;.
Outlined pills: set --pill-bg: transparent; so only the border shows.
Home icon: in the breadcrumb entry, put <span class="fa fa-home" aria-hidden="true"></span> Home in the label. If your version has an icon field for the entry, use that instead.

If the old separator still appears, open your browser's dev tools and check which element draws it. Your version may use a slightly different class, so adjust the ::after rule to match.